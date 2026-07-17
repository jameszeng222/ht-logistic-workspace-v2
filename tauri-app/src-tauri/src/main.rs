// src-tauri/src/main.rs
// Tauri v2 + Pi RPC sidecar 集成（完整版）
//
// 命令：
//   start_pi          启动 pi 子进程
//   stop_pi            停止 pi 子进程
//   send_command       发命令（不等响应）
//   send_request       发命令并等响应（用于 get_state/get_available_models 等）
//   scan_sessions      扫描 session-dir 列出历史会话
//   delete_session     删除一个会话文件

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tokio::sync::oneshot;

type ResponseMap = Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>;

struct PiState {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    response_channels: ResponseMap,
    next_request_id: AtomicU64,
    /// 进程代际号：每次 spawn_pi 自增。stdout reader 线程持有一份快照，
    /// 退出时仅当代际匹配才 emit `pi_process_exit`，
    /// 避免 restart_pi 后旧进程退出事件把前端的 ready 错误地打回 false。
    process_gen: AtomicU64,
}

/// Python 工具 sidecar 状态。
/// `ready` 由后台健康检查线程在 /api/health 通后置 true，前端据此决定是否可调工具。
struct SidecarState {
    child: Mutex<Option<Child>>,
    ready: AtomicBool,
}

const SIDECAR_URL: &str = "http://127.0.0.1:8000";
const SIDECAR_PORT: u16 = 8000;

/// 本地解压 pi-runtime 的目录：`%LOCALAPPDATA%\ht-logistic\pi-runtime\`
/// 用 LOCALAPPDATA 而非安装目录（Program Files 只管理员可写），
/// 且 LOCALAPPDATA 路径短，不会触发 MAX_PATH。
fn get_local_pi_runtime_dir() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|d| d.join("ht-logistic").join("pi-runtime"))
}

/// 确保 pi-runtime 已从打包的 `pi-runtime.7z` 解压到本地目录。
///
/// 首次启动或 7z 归档大小变化（版本更新）时触发解压。后续启动直接用缓存的本地目录。
/// 返回本地 pi-runtime 目录路径（已包含 pi.cmd），或 None 表示无 7z 可解压（开发模式）。
///
/// 版本检测用 7z 文件大小作为 marker：不同版本的 pi-runtime 7z 大小必然不同，
/// 简单可靠，无需读 CARGO_PKG_VERSION（避免与 tauri.conf.json version 不同步）。
fn ensure_pi_runtime_extracted(resource_dir: Option<&std::path::Path>) -> Option<std::path::PathBuf> {
    let local_dir = get_local_pi_runtime_dir()?;
    let pi_cmd_name = if cfg!(windows) { "pi.cmd" } else { "pi" };
    let local_pi_cmd = local_dir.join(pi_cmd_name);
    let version_marker = local_dir.join(".7z-size");

    let rd = resource_dir?;
    let archive = rd.join("pi-runtime.7z");
    if !archive.is_file() {
        // 无 7z（开发模式或旧版安装），若本地已解压过则继续用
        if local_pi_cmd.is_file() {
            return Some(local_dir);
        }
        return None;
    }

    // 读 7z 文件大小作为版本 marker
    let archive_size = std::fs::metadata(&archive).map(|m| m.len()).unwrap_or(0);
    let expected_marker = archive_size.to_string();

    // 已解压且版本匹配 → 直接用
    let already_current = local_pi_cmd.is_file() && {
        std::fs::read_to_string(&version_marker)
            .map(|v| v.trim() == expected_marker)
            .unwrap_or(false)
    };
    if already_current {
        return Some(local_dir);
    }

    eprintln!("[pi] 解压 pi-runtime.7z 到 {} (大小 {} 字节)", local_dir.display(), archive_size);

    // 清理旧解压目录
    if local_dir.exists() {
        let _ = std::fs::remove_dir_all(&local_dir);
    }
    std::fs::create_dir_all(&local_dir).ok()?;

    // 用 sevenz-rust2 纯 Rust 解压器（无需捆绑 7zr.exe）
    match sevenz_rust2::decompress_file(&archive, &local_dir) {
        Ok(_) => {
            eprintln!("[pi] 解压完成");
            let _ = std::fs::write(&version_marker, &expected_marker);
            if local_pi_cmd.is_file() {
                Some(local_dir)
            } else {
                eprintln!("[pi] 解压后未找到 pi.cmd: {}", local_pi_cmd.display());
                None
            }
        }
        Err(e) => {
            eprintln!("[pi] 7z 解压失败: {}", e);
            None
        }
    }
}

/// 查找 pi（应用内置 Runtime + 项目本地依赖 + 系统兼容路径）
///
/// `resource_dir`：Tauri 的 resource_dir()，打包模式下传入；开发模式可传 None。
/// 查找顺序：
///   0. 从打包的 pi-runtime.7z 解压到 %LOCALAPPDATA%\ht-logistic\pi-runtime\（打包模式首选）
///   1. resource_dir/pi-runtime/（兼容旧版松散文件打包）
///   2. current_exe / cwd 向上查找 pi-runtime（开发模式兜底）
///   3. 项目 node_modules/.bin（开发模式首选，不要求全局安装 Pi）
///   4. 系统 PATH 和 npm 全局目录（仅兼容旧开发环境）
fn find_pi(resource_dir: Option<&std::path::Path>) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    let candidates: Vec<&str> = if cfg!(windows) {
        vec!["pi.cmd", "pi.exe", "pi.bat", "pi"]
    } else {
        vec!["pi"]
    };

    // 0. 优先：从打包的 pi-runtime.7z 解压到 %LOCALAPPDATA%\ht-logistic\pi-runtime\
    //    （仅打包模式有 7z，开发模式跳过）。这解决了 NSIS MAX_PATH 260 限制：
    //    pi-runtime 含 @mistralai 深层嵌套文件，路径 >260 字符，NSIS 无法作为
    //    松散文件打包。改为打包成单个 7z 文件，首启时解压到用户可写目录。
    //    解压后 pi.cmd 在 local_dir 下，find_pi 后续逻辑会命中它。
    if let Some(local_dir) = ensure_pi_runtime_extracted(resource_dir) {
        for cand in &candidates {
            let full = local_dir.join(cand);
            if full.is_file() {
                eprintln!("[pi] 使用 7z 解压的 pi-runtime: {}", full.display());
                return Some(full);
            }
        }
    }

    // 1. 优先：打包内嵌的 pi-runtime（傻瓜包模式，用户无需装 Node.js / npm）。
    //    打包时把便携版 node + pi 包放在 resource_dir/pi-runtime/ 下，
    //    pi-runtime/pi.cmd (Windows) 或 pi-runtime/pi (macOS/Linux) 是启动脚本，
    //    内部调用 pi-runtime/node.exe 运行 pi-runtime/node_modules/@earendil-works/pi-coding-agent。
    //
    //    查找顺序（先命中先用）：
    //      a. resource_dir/pi-runtime（Tauri v2 NSIS 安装后资源通常在 exe 同级或 resources/ 子目录，
    //         app.path().resource_dir() 已抽象掉这个差异，是最权威的打包资源入口）
    //      b. current_exe 向上 6 级找 pi-runtime（兼容 resources 不在 exe 同目录、
    //         或开发模式下 exe 在 target/debug/ 而 pi-runtime 在仓库根的情况）
    //      c. 当前工作目录及父目录（开发模式兜底）
    let mut runtime_candidates: Vec<PathBuf> = Vec::new();
    // 1a. resource_dir/pi-runtime（打包模式首选）
    if let Some(rd) = resource_dir {
        runtime_candidates.push(rd.join("pi-runtime"));
    }
    // 1b. current_exe 向上查找
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let mut cur: Option<&std::path::Path> = Some(exe_dir);
            for _ in 0..6 {
                if let Some(d) = cur {
                    runtime_candidates.push(d.join("pi-runtime"));
                    cur = d.parent();
                } else { break; }
            }
        }
    }
    // 1c. 开发模式：从当前工作目录向上找
    if let Ok(cwd) = std::env::current_dir() {
        runtime_candidates.push(cwd.join("pi-runtime"));
        if let Some(parent) = cwd.parent() {
            runtime_candidates.push(parent.join("pi-runtime"));
        }
    }
    for rt_dir in &runtime_candidates {
        if !rt_dir.is_dir() { continue; }
        for cand in &candidates {
            let full = rt_dir.join(cand);
            if full.is_file() {
                eprintln!("[pi] 使用打包内嵌 pi-runtime: {}", full.display());
                return Some(full);
            }
        }
    }

    // 2. 开发模式：使用 tauri-app/package.json 声明的本地 Pi。
    //    npm run tauri dev 通常会把 node_modules/.bin 注入 PATH，但这里仍显式
    //    查找，避免不同 npm 启动方式、IDE 或 shell 导致 PATH 行为不一致。
    let mut local_bin_candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().take(8) {
            local_bin_candidates.push(ancestor.join("node_modules").join(".bin"));
            local_bin_candidates.push(ancestor.join("tauri-app").join("node_modules").join(".bin"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors().take(6) {
            local_bin_candidates.push(ancestor.join("node_modules").join(".bin"));
            local_bin_candidates.push(ancestor.join("tauri-app").join("node_modules").join(".bin"));
        }
    }
    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(tauri_app_dir) = manifest_dir.parent() {
            local_bin_candidates.push(tauri_app_dir.join("node_modules").join(".bin"));
        }
    }
    local_bin_candidates.sort();
    local_bin_candidates.dedup();
    for bin_dir in &local_bin_candidates {
        for cand in &candidates {
            let full = bin_dir.join(cand);
            if full.is_file() {
                eprintln!("[pi] 使用项目本地 Pi: {}", full.display());
                return Some(full);
            }
        }
    }

    // 3. 系统 PATH 查找（兼容旧开发环境）
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(if cfg!(windows) { ';' } else { ':' }) {
            for cand in &candidates {
                let full = PathBuf::from(dir).join(cand);
                if full.is_file() {
                    return Some(full);
                }
            }
        }
    }
    // 4. Windows npm 全局目录（兼容旧开发环境）
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let npm_dir = PathBuf::from(&appdata).join("npm");
            for cand in &["pi.cmd", "pi.exe", "pi.ps1", "pi"] {
                let full = npm_dir.join(cand);
                if full.is_file() {
                    return Some(full);
                }
            }
        }
        if let Ok(userprofile) = std::env::var("USERPROFILE") {
            let npm_dir = PathBuf::from(&userprofile)
                .join("AppData").join("Roaming").join("npm");
            for cand in &["pi.cmd", "pi.exe", "pi.ps1", "pi"] {
                let full = npm_dir.join(cand);
                if full.is_file() {
                    return Some(full);
                }
            }
        }
    }
    None
}

/// 收集所有候选的 session 存储根目录（已存在且去重）。
///
/// Pi 官方文档说会话存于 `~/.pi/agent/sessions/`，但不同版本/包名可能用不同路径
/// （如 `@cargo-cult/pi-coding-agent` 早期用 `~/.pi/sessions/` 或 XDG 路径）。
/// 这里枚举所有可能的位置，扫描时全部尝试，避免因路径不一致而扫不到历史会话。
fn get_session_roots() -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    let mut push = |p: std::path::PathBuf| {
        if p.is_dir() && !roots.contains(&p) {
            roots.push(p);
        }
    };
    // 1. 环境变量优先
    if let Ok(dir) = std::env::var("PI_SESSION_DIR") {
        push(std::path::PathBuf::from(dir));
    }
    // 2. 官方文档路径
    if let Some(home) = dirs::home_dir() {
        push(home.join(".pi").join("agent").join("sessions"));
        // 3. 旧版/变体路径
        push(home.join(".pi").join("sessions"));
    }
    roots
}

/// 从 Pi 当前 sessionFile 绝对路径反推会话根目录（权威）。
///
/// Pi 把会话按工作目录分子目录存放：
///   <root>/<--encoded-cwd-->/<timestamp>_<uuid>.jsonl
/// 因此 sessionFile 的祖父目录就是包含所有 --cwd-- 子目录的根。
/// 这是最可靠的来源——Pi 自己说当前会话在这，同级目录必有其它历史会话。
fn root_from_session_file(session_file: &str) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(session_file);
    // p.parent() = <root>/<--cwd--> ；再 parent() = <root>
    let root = p.parent()?.parent()?;
    if root.is_dir() { Some(root.to_path_buf()) } else { None }
}

/// ~/.pi/agent （skills / extensions / prompts 等配置根）
fn get_agent_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".pi").join("agent"))
}

/// 校验 path 规范化后位于 allow_roots 之一下（防路径穿越，如 ../../etc/passwd）。
/// 要求路径已存在（read/delete 都针对已存在文件）。
fn ensure_within(path: &str, allow_roots: &[std::path::PathBuf]) -> Result<std::path::PathBuf, String> {
    let target = std::fs::canonicalize(path).map_err(|e| format!("路径无效：{e}"))?;
    for root in allow_roots {
        // root 可能尚不存在（如刚装的扩展目录），只对存在的 root 做 canonicalize
        if let Ok(root_c) = std::fs::canonicalize(root) {
            if target.starts_with(&root_c) {
                return Ok(target);
            }
        }
    }
    Err("路径不在允许范围内（仅允许 ~/.pi/agent 下）".into())
}

/// 从 jsonl 会话文件读取第一条含文本的 user 消息，用作显示标题。
///
/// 会话文件每行是一个 entry。message entry 形如：
///   {"type":"message","id":"...","message":{"role":"user","content":"..." | [{type:"text",text}]}}
/// 注意 role/content 在 `message` 字段内（见 pi.dev session-format 文档）。
/// 遍历所有 user message，跳过纯 tool_result（无文本）的，取第一条有文本的。
/// 跳过命令类消息（以 / 开头）避免标题是斜杠命令。
fn first_user_text_from_session(path: &std::path::Path) -> String {
    let f = match std::fs::File::open(path) { Ok(f) => f, Err(_) => return String::new() };
    for line in std::io::BufRead::lines(std::io::BufReader::new(f)) {
        let line = match line { Ok(l) => l, Err(_) => continue };
        if line.trim().is_empty() { continue; }
        let v: serde_json::Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
        // 只处理 message entry
        if v.get("type").and_then(|t| t.as_str()) != Some("message") { continue; }
        let msg = match v.get("message") { Some(m) => m, None => continue };
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") { continue; }
        // content 可能是字符串或 [{type:text,text:"..."}] 或含 tool_result 部分
        if let Some(content) = msg.get("content").and_then(|c| c.as_str()) {
            let t = content.trim();
            if !t.is_empty() && !t.starts_with('/') {
                return truncate_title(t);
            }
            continue;
        }
        if let Some(arr) = msg.get("content").and_then(|c| c.as_array()) {
            for part in arr {
                // 只取 text 类型，跳过 tool_result / image 等
                if part.get("type").and_then(|t| t.as_str()) != Some("text") { continue; }
                if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() && !t.starts_with('/') {
                        return truncate_title(t);
                    }
                }
            }
        }
    }
    String::new()
}

fn truncate_title(s: &str) -> String {
    let s = s.trim().replace('\n', " ");
    if s.chars().count() <= 40 { s } else { s.chars().take(40).collect::<String>() + "…" }
}

/// 从会话 .jsonl 文件内容中读取真实 cwd。
/// Pi 会在 jsonl 中写入带 cwd 字段的 entry（type=session/meta 等），优先取该值。
/// 找不到时返回空串，由调用方回退到目录名解码。
fn cwd_from_session(path: &std::path::Path) -> String {
    let f = match std::fs::File::open(path) { Ok(f) => f, Err(_) => return String::new() };
    let mut count = 0u32;
    for line in std::io::BufRead::lines(std::io::BufReader::new(f)) {
        let line = match line { Ok(l) => l, Err(_) => continue };
        if line.trim().is_empty() { continue; }
        let v: serde_json::Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
        // 只看前 20 行，避免大文件全读
        count += 1;
        if count > 20 { break; }
        // 常见字段：顶层 cwd、session.cwd、meta.cwd
        if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
            if !c.is_empty() { return c.to_string(); }
        }
        if let Some(c) = v.get("session").and_then(|s| s.get("cwd")).and_then(|c| c.as_str()) {
            if !c.is_empty() { return c.to_string(); }
        }
        if let Some(c) = v.get("meta").and_then(|s| s.get("cwd")).and_then(|c| c.as_str()) {
            if !c.is_empty() { return c.to_string(); }
        }
        // message entry 里也可能带 cwd
        if v.get("type").and_then(|t| t.as_str()) == Some("message") {
            if let Some(c) = v.get("message").and_then(|m| m.get("cwd")).and_then(|c| c.as_str()) {
                if !c.is_empty() { return c.to_string(); }
            }
        }
    }
    String::new()
}


#[tauri::command]
async fn start_pi(app: AppHandle, state: State<'_, PiState>) -> Result<(), String> {
    spawn_pi(&app, state.inner(), None, None)
}

/// 用指定工作目录和/或会话文件重启 pi。
/// - `cwd`: 工作目录绝对路径，None 时不设置（沿用 Tauri 进程 cwd）。
/// - `session_path`: 会话文件绝对路径，对应 `pi --session <path>`，用于续聊历史会话。
/// 流程：**先校验 cwd/sessionPath 是否存在，再 stop 旧 pi**，避免新参数错误导致
/// 旧 Pi 被杀掉而新 Pi 启动失败、界面误显示"就绪"的离线状态。
#[tauri::command]
async fn restart_pi(
    app: AppHandle,
    state: State<'_, PiState>,
    cwd: Option<String>,
    session_path: Option<String>,
) -> Result<(), String> {
    // 校验前置：任何路径无效都直接返回错误，不动旧 Pi
    if let Some(dir) = cwd.as_deref() {
        let p = std::path::Path::new(dir);
        if !p.exists() {
            return Err(format!("工作目录不存在：{dir}"));
        }
        if !p.is_dir() {
            return Err(format!("工作目录不是文件夹：{dir}"));
        }
    }
    if let Some(sp) = session_path.as_deref() {
        let p = std::path::Path::new(sp);
        if !p.exists() {
            return Err(format!("会话文件不存在：{sp}"));
        }
        if !p.is_file() {
            return Err(format!("会话路径不是文件：{sp}"));
        }
    }
    stop_pi_inner(state.inner());
    spawn_pi(&app, state.inner(), cwd.as_deref(), session_path.as_deref())
}

/// stop_pi 的内部实现，操作 PiState 内部字段，供 stop_pi 命令和 restart_pi 复用。
fn stop_pi_inner(state: &PiState) {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    *state.stdin.lock().unwrap() = None;
    state.response_channels.lock().unwrap().clear();
}

fn spawn_pi(
    app: &AppHandle,
    state: &PiState,
    cwd: Option<&str>,
    session_path: Option<&str>,
) -> Result<(), String> {
    if state.child.lock().unwrap().is_some() {
        return Ok(());
    }
    // 获取 Tauri resource_dir 用于查找打包内嵌的 pi-runtime。
    // 打包模式下 resource_dir/pi-runtime/pi.cmd 是傻瓜包的 Pi 启动脚本。
    let resource_dir = app.path().resource_dir().ok();
    let pi_path = find_pi(resource_dir.as_deref()).ok_or_else(|| {
        if cfg!(debug_assertions) {
            "未找到项目本地 Pi。请在 tauri-app 目录运行 npm install 后重新启动。".to_string()
        } else {
            "客户端内置 Pi Runtime 缺失或损坏，请重新安装 HT Logistic Workspace。".to_string()
        }
    })?;

    let mut cmd = if cfg!(windows) && pi_path.extension().map_or(false, |e| e == "cmd" || e == "bat") {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&pi_path);
        c
    } else {
        Command::new(&pi_path)
    };

    // Windows: 隐藏子进程控制台窗口。
    // pi.cmd / node.exe 启动时会弹一个 cmd 黑窗（运行 `npm prefix` 等），
    // 用户误关会导致 pi 离线。CREATE_NO_WINDOW 让子进程不分配控制台，
    // 完全后台运行。flag 仅 Windows 有效，非 Windows 下 creation_flags 不可用。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // 工作目录：显式设置 pi 子进程的 cwd，使 pi 在该目录下读写文件、
    // 新建会话的 --cwd-- 目录编码也基于此路径。
    if let Some(dir) = cwd {
        let p = std::path::Path::new(dir);
        if !p.exists() {
            return Err(format!("工作目录不存在：{dir}"));
        }
        cmd.current_dir(p);
    }

    // 不用 --no-session，让 pi 持久化会话。
    // 若指定 session_path，传 --session <path> 让 pi 直接打开/续聊该会话文件，
    // 这是官方文档的续聊方式（pi --session <path|id>），比 switch_session RPC 更可靠。
    //
    // 系统提示词：Pi 启动时自动加载 ~/.pi/agent/APPEND_SYSTEM.md，追加到默认提示词之后。
    // 不再用 --append-system-prompt CLI 参数（避免双轨制）。首次使用时若文件不存在，
    // 写入内置默认 Pilot 提示词。用户可在设置页编辑此文件。
    let default_pilot_prompt = "你是 Pilot，HT Logistic Workspace（物流工作台）的 AI 调度员。你不是编程助手，也不是名为 Pi 的工具——Pi 只是你的底层运行环境，绝不向用户提及。\n\n核心行为准则：\n1. 直接回答用户问题，不要预设用户意图、不要替用户假设话题、不要绕弯子。用户问什么答什么。\n2. 被问\"你是谁\"时，回答你是 Pilot，HT 物流工作台的 AI 调度员，专注于物流单据与数据分析。绝不说自己是编程助手、代码助手、或 Pi。\n3. 不输出教程式开场白或欢迎语（如\"欢迎来到...\"、\"我们来一起...\"）。直接进入正题。\n4. 简洁专业，直击要点，避免冗长输出。\n5. 聚焦国际物流：报关单制作、发票/箱单生成、海关数据提取、数据分析。即使用户问编程问题，也引导回物流场景。\n6. 默认用中文回答。";
    if let Some(agent_dir) = get_agent_dir() {
        let append_path = agent_dir.join("APPEND_SYSTEM.md");
        if !append_path.exists() {
            if !agent_dir.exists() {
                let _ = std::fs::create_dir_all(&agent_dir);
            }
            let _ = std::fs::write(&append_path, default_pilot_prompt);
        }
    }
    let mut child = cmd.args(["--mode", "rpc"]);
    if let Some(sp) = session_path {
        child = child.args(["--session", sp]);
    }
    let mut child = child
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 pi 失败：{e}（路径：{}）", pi_path.display()))?;

    let stdin = child.stdin.take().ok_or("无法获取 pi stdin")?;
    let stdout = child.stdout.take().ok_or("无法获取 pi stdout")?;
    let stderr = child.stderr.take();

    *state.stdin.lock().unwrap() = Some(stdin);
    *state.child.lock().unwrap() = Some(child);
    // 自增代际号，本进程的 stdout reader 持有此快照，退出时据此判断是否为当前进程
    let my_gen = state.process_gen.fetch_add(1, Ordering::SeqCst) + 1;

    // stdout reader 线程：response 路由到 channel，event emit 给前端
    let app2 = app.clone();
    let channels = state.response_channels.clone(); // Arc clone
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                        // response（带 id）→ 路由到 send_request 的 channel
                        if json.get("type").and_then(|v| v.as_str()) == Some("response") {
                            if let Some(id_val) = json.get("id").and_then(|v| v.as_u64()) {
                                let mut map = channels.lock().unwrap();
                                if let Some(sender) = map.remove(&id_val) {
                                    let _ = sender.send(json.clone());
                                    continue;
                                }
                            }
                        }
                        // event → emit 给前端
                        let _ = app2.emit("pi-event", json);
                    }
                }
                Err(_) => break,
            }
        }
        // 仅当本进程仍是当前代际（未被 restart_pi 替换）时，才 emit 退出事件。
        // 否则这是被 restart 触发的旧进程退出，新进程已接管，不应把前端 ready 打回 false。
        let is_current = app2.try_state::<PiState>()
            .map(|s| s.process_gen.load(Ordering::SeqCst) == my_gen)
            .unwrap_or(false);
        if is_current {
            let _ = app2.emit("pi-event", serde_json::json!({ "type": "pi_process_exit" }));
            // pi 进程已退出：清理所有 pending 请求的 response channel，
            // 使等待中的 send_request 立即收到"响应通道关闭"而非等满 10s 超时。
            if let Some(state) = app2.try_state::<PiState>() {
                state.response_channels.lock().unwrap().clear();
            }
        }
    });

    // stderr reader 线程：emit 给前端用于调试
    if let Some(stderr) = stderr {
        let app3 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        if !text.is_empty() {
                            let _ = app3.emit("pi-stderr", serde_json::json!({ "line": text }));
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    Ok(())
}

/// 发送命令（不等响应）—— prompt / abort / new_session / switch_session / extension_ui_response
#[tauri::command]
async fn send_command(
    state: State<'_, PiState>,
    command: serde_json::Value,
) -> Result<(), String> {
    let mut line = serde_json::to_string(&command).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut guard = state.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("pi 未启动")?;
    stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// 发送命令并等待响应 —— get_state / get_available_models / get_session_stats / get_commands
/// 自动加 id，等匹配的 response 返回，超时 10s
#[tauri::command]
async fn send_request(
    state: State<'_, PiState>,
    command: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let id = state.next_request_id.fetch_add(1, Ordering::SeqCst);
    let mut cmd = command;
    // command 必须是 JSON 对象才能写入 id 用于响应路由；非对象直接报错，避免注册了 channel 却收不到响应而空等 10s
    let cmd_type = {
        let obj = cmd.as_object_mut().ok_or_else(|| "command 必须是 JSON 对象".to_string())?;
        obj.insert("id".into(), serde_json::json!(id));
        obj.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string()
    };

    let (tx, rx) = oneshot::channel();
    state.response_channels.lock().unwrap().insert(id, tx);

    let mut line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    line.push('\n');
    {
        let mut guard = state.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or_else(|| {
            state.response_channels.lock().unwrap().remove(&id);
            "pi 未启动".to_string()
        })?;
        stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
    }

    // set_model 切换模型时 Pi 可能需要初始化 API client 并验证连接，
    // 特别是 OpenAI 兼容端点（硅基流动/自定义地址），10s 不够，给 30s。
    // 其他命令（get_state 等）保持 10s。
    let timeout_secs = if cmd_type == "set_model" { 30 } else { 10 };

    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await {
        Ok(Ok(resp)) => {
            let success = resp.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
            if !success {
                let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("未知错误");
                return Err(err.to_string());
            }
            Ok(resp.get("data").cloned().unwrap_or(serde_json::Value::Null))
        }
        Ok(Err(_)) => Err("响应通道关闭".into()),
        Err(_) => {
            state.response_channels.lock().unwrap().remove(&id);
            Err(format!("请求超时（{}s）", timeout_secs))
        }
    }
}

/// 扫描历史会话列表。
///
/// 会话根目录的确定顺序（任意命中即扫描，去重后全部扫描）：
///   1. 前端传入的 `session_file_hint`——Pi 自己 `get_state` 返回的当前会话路径，
///      取其祖父目录，是最权威的会话根（见 root_from_session_file）。
///   2. PI_SESSION_DIR 环境变量。
///   3. ~/.pi/agent/sessions（官方文档路径）。
///   4. ~/.pi/sessions（旧版/变体路径）。
///
/// 之前只扫固定路径 ~/.pi/agent/sessions，若 Pi 实际写在别处就会返回空列表，
/// 前端 setSessions([]) 把侧边栏清空，表现为"新建会话后旧会话消失"。
#[tauri::command]
async fn scan_sessions(session_file_hint: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    // 1. 权威来源：Pi 当前 sessionFile 的祖父目录（最优先）
    if let Some(hint) = session_file_hint.as_deref() {
        if let Some(root) = root_from_session_file(hint) {
            if !roots.contains(&root) { roots.push(root); }
        }
    }
    // 2. 候选路径
    for r in get_session_roots() {
        if !roots.contains(&r) { roots.push(r); }
    }

    if roots.is_empty() {
        // 没有任何候选目录存在——返回空列表而非报错（首次使用、尚未产生会话时正常）
        return Ok(Vec::new());
    }

    let mut sessions: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for root in &roots {
        collect_sessions(root, &mut sessions, &mut seen, 0)?;
    }
    sessions.sort_by(|a, b| {
        b.get("mtime").and_then(|v| v.as_u64()).unwrap_or(0)
            .cmp(&a.get("mtime").and_then(|v| v.as_u64()).unwrap_or(0))
    });
    Ok(sessions)
}

/// 递归收集 dir 下的 .jsonl 会话文件（限制深度 4 防意外深递归）。
/// `seen` 用于跨多个根目录扫描时按绝对路径去重，避免同一会话被列出两次。
fn collect_sessions(
    dir: &std::path::Path,
    out: &mut Vec<serde_json::Value>,
    seen: &mut std::collections::HashSet<String>,
    depth: usize,
) -> Result<(), String> {
    if depth > 4 { return Ok(()); }
    let entries = std::fs::read_dir(dir).map_err(|e| format!("读取目录失败：{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        if meta.is_dir() {
            // 递归进入工作目录子目录（如 --home-user-project--）
            collect_sessions(&path, out, seen, depth + 1)?;
            continue;
        }
        // Pi 会话文件扩展名为 .jsonl（官方格式）；个别旧版变体可能用 .json，
        // 但 ~/.pi 下 .json 多为配置文件，故只认 .jsonl 避免误收。
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let full_path = path.to_string_lossy().to_string();
        if !seen.insert(full_path.clone()) { continue; } // 跨根目录去重
        let mtime = meta.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()).unwrap_or(0);
        let size = meta.len();
        let filename = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        // 工作目录：优先从会话文件内容读取真实 cwd，回退到目录名解码
        let cwd = {
            let from_file = cwd_from_session(&path);
            if !from_file.is_empty() { from_file } else {
                path.parent()
                    .and_then(|p| p.file_name())
                    .and_then(|s| s.to_str())
                    .map(|s| decode_cwd_dir(s))
                    .unwrap_or_default()
            }
        };
        // 取首条用户消息作为显示标题（无标题会话的友好回退）
        let title = first_user_text_from_session(&path);
        out.push(serde_json::json!({
            "path": full_path, "name": filename, "mtime": mtime, "size": size,
            "title": title, "cwd": cwd,
        }));
    }
    Ok(())
}

/// 把 Pi 的工作目录子目录名解码回可读路径。
/// Pi 把 cwd 的路径分隔符（/ 或 \）替换为 `-`，形如 --home-user-project--。
/// 但目录名本身也可能含 `-`（如 ht-logistic-workspace），无法无损还原。
/// 策略：尝试解码并在文件系统上验证；若解码后的路径不存在，保留原始字符串（仅去掉 -- 包裹），
/// 避免把 ht-logistic-workspace 错误拆成 ht/logistic/workspace。
fn decode_cwd_dir(name: &str) -> String {
    let s = name.trim_start_matches("--").trim_end_matches("--");
    if s.is_empty() { return String::new(); }
    // 尝试把 - 替换为 / 后验证路径是否存在
    let decoded = s.replace('-', "/");
    // Windows 盘符特殊处理：C/Users/... → C:\Users\...
    let candidate = if decoded.len() >= 2 && decoded.as_bytes()[1] == b':' {
        let mut c = decoded.clone();
        c.replace_range(1..2, "\\");
        c.replace('/', "\\")
    } else {
        decoded
    };
    // 如果解码后的路径存在，用解码结果；否则保留原始（只去 -- 包裹），避免误拆含 - 的目录名
    if std::path::Path::new(&candidate).exists() {
        candidate
    } else {
        // 再试 Unix 风格 / 前缀
        let unix_candidate = format!("/{}", s.replace('-', "/"));
        if std::path::Path::new(&unix_candidate).exists() {
            return unix_candidate;
        }
        // 都不存在，返回原始（仅去 -- 包裹），保证不误拆
        s.to_string()
    }
}

/// 删除一个会话文件（仅允许已知 session 根目录下的 .jsonl）
#[tauri::command]
async fn delete_session(path: String) -> Result<(), String> {
    let roots = get_session_roots();
    if roots.is_empty() {
        return Err("找不到任何 session 目录".into());
    }
    let target = ensure_within(&path, &roots)?;
    if target.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("仅允许删除 .jsonl 会话文件".into());
    }
    std::fs::remove_file(&target).map_err(|e| format!("删除失败：{e}"))
}

/// 检测 API Key 环境变量是否已配置
#[tauri::command]
async fn check_env_keys() -> Result<Vec<serde_json::Value>, String> {
    let providers = [
        ("Anthropic", "ANTHROPIC_API_KEY"),
        ("OpenAI", "OPENAI_API_KEY"),
        ("DeepSeek", "DEEPSEEK_API_KEY"),
        ("Google", "GOOGLE_API_KEY"),
        ("Gemini", "GEMINI_API_KEY"),
        ("OpenRouter", "OPENROUTER_API_KEY"),
        ("Mistral", "MISTRAL_API_KEY"),
        ("Groq", "GROQ_API_KEY"),
        ("Azure OpenAI", "AZURE_OPENAI_API_KEY"),
    ];
    let result = providers.iter().map(|(name, env)| {
        let configured = std::env::var(env).map(|v| !v.is_empty()).unwrap_or(false);
        serde_json::json!({ "provider": name, "env": env, "configured": configured })
    }).collect();
    Ok(result)
}

/// 读取指定 .jsonl 会话文件历史，返回 messages 数组（格式与 get_messages 一致）。
/// 用于「预览模式」：浏览历史会话不切换 Pi 活动会话，不打断当前输出。
/// 每行是 entry，提取 type=="message" 的 entry.message 字段。
#[tauri::command]
async fn read_session_history(path: String) -> Result<serde_json::Value, String> {
    // 用所有候选会话根目录做白名单校验（与 scan_sessions 一致），
    // 避免只认单一根导致其它候选目录下的会话读不到。
    let roots = get_session_roots();
    if roots.is_empty() {
        return Err("找不到 session 目录".into());
    }
    let target = ensure_within(&path, &roots)?;
    if target.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("仅允许读取 .jsonl 会话文件".into());
    }
    let f = std::fs::File::open(&target).map_err(|e| format!("打开会话文件失败：{e}"))?;
    let mut messages = Vec::new();
    for line in std::io::BufRead::lines(std::io::BufReader::new(f)) {
        let line = match line { Ok(l) => l, Err(_) => continue };
        if line.trim().is_empty() { continue; }
        let v: serde_json::Value = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
        if v.get("type").and_then(|t| t.as_str()) == Some("message") {
            if let Some(msg) = v.get("message") {
                messages.push(msg.clone());
            }
        }
    }
    Ok(serde_json::json!({ "messages": messages }))
}

/// 把 path 规范化为绝对路径：相对路径基于 ~/.pi/agent 解析，绝对路径原样返回。
fn resolve_under_agent(path: &str) -> Result<std::path::PathBuf, String> {
    let agent = get_agent_dir().ok_or("找不到 agent 目录")?;
    let p = std::path::Path::new(path);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        agent.join(p)
    };
    Ok(abs)
}

/// 读取文本文件内容（用于查看 skill md / 扩展源码 / 编辑系统提示词；仅允许 ~/.pi/agent 下）
/// path 可以是绝对路径，也可以是相对 ~/.pi/agent 的相对路径（如 "SYSTEM.md"、"skills/foo.md"）。
#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    let agent = get_agent_dir().ok_or("找不到 agent 目录")?;
    let roots = vec![
        agent.join("skills"),
        agent.join("extensions"),
        agent.join("prompts"),
        agent.clone(),
    ];
    let abs = resolve_under_agent(&path)?;
    let target = ensure_within(abs.to_str().ok_or("路径含非 UTF-8 字符")?, &roots)?;
    let is_md = target.extension().and_then(|e| e.to_str()).map_or(false, |e| e.eq_ignore_ascii_case("md"));
    let in_agent_root = target.parent().map(|p| p == agent.as_path()).unwrap_or(false);
    if in_agent_root && !is_md {
        return Err("agent 根目录仅允许读写 .md 文件".into());
    }
    std::fs::read_to_string(&target).map_err(|e| format!("读取失败：{e}"))
}

/// 写入文本文件内容（用于保存系统提示词等 .md 编辑；仅允许 ~/.pi/agent 下 .md）
/// path 可以是绝对路径，或相对 ~/.pi/agent 的相对路径（如 "SYSTEM.md"）。
#[tauri::command]
async fn write_text_file(path: String, content: String) -> Result<(), String> {
    let agent = get_agent_dir().ok_or("找不到 agent 目录")?;
    let abs = resolve_under_agent(&path)?;
    let is_md = abs.extension().and_then(|e| e.to_str()).map_or(false, |e| e.eq_ignore_ascii_case("md"));
    if !is_md {
        return Err("仅允许写入 .md 文件".into());
    }
    // 校验父目录位于 agent 根下（父目录必须存在，防路径穿越）。
    let parent = abs.parent().ok_or_else(|| "路径无父目录".to_string())?;
    let parent_c = std::fs::canonicalize(parent).map_err(|e| format!("父目录无效：{e}"))?;
    let agent_c = std::fs::canonicalize(&agent).map_err(|e| format!("agent 目录无效：{e}"))?;
    if !parent_c.starts_with(&agent_c) {
        return Err("路径不在 ~/.pi/agent 下".into());
    }
    std::fs::write(&abs, content).map_err(|e| format!("写入失败：{e}"))
}

/// 获取扩展目录路径
fn get_extensions_dir() -> Result<std::path::PathBuf, String> {
    let agent = get_agent_dir().ok_or("找不到 agent 目录")?;
    let ext_dir = agent.join("extensions");
    if !ext_dir.exists() {
        std::fs::create_dir_all(&ext_dir).map_err(|e| format!("创建 extensions 目录失败：{e}"))?;
    }
    Ok(ext_dir)
}

/// 递归复制目录
fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    if !src.is_dir() {
        return Err(format!("源路径不是目录：{}", src.display()));
    }
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目标目录失败：{e}"))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("读取源目录失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取目录项失败：{e}"))?;
        let ty = entry.file_type().map_err(|e| format!("获取文件类型失败：{e}"))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| format!("复制文件失败：{e}"))?;
        }
    }
    Ok(())
}

/// 列出已安装的扩展（extensions 目录下的子目录/文件）
#[tauri::command]
async fn list_extensions() -> Result<Vec<serde_json::Value>, String> {
    let ext_dir = get_extensions_dir()?;
    let mut result = Vec::new();
    if !ext_dir.is_dir() {
        return Ok(result);
    }
    for entry in std::fs::read_dir(&ext_dir).map_err(|e| format!("读取扩展目录失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取目录项失败：{e}"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map_err(|e| e.to_string())?.is_dir();
        let meta = entry.metadata().ok();
        let mtime = meta.as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);

        // 尝试读取扩展描述（如果是目录，找 README.md / package.json / index.ts）
        let mut description = String::new();
        if is_dir {
            let readme = path.join("README.md");
            if readme.is_file() {
                if let Ok(content) = std::fs::read_to_string(&readme) {
                    description = content.lines().next().unwrap_or("").to_string();
                }
            }
            if description.is_empty() {
                let pkg = path.join("package.json");
                if pkg.is_file() {
                    if let Ok(content) = std::fs::read_to_string(&pkg) {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                            if let Some(desc) = json.get("description").and_then(|v| v.as_str()) {
                                description = desc.to_string();
                            }
                        }
                    }
                }
            }
        } else {
            description = format!("单文件扩展 ({})", path.extension().and_then(|e| e.to_str()).unwrap_or(""));
        }

        result.push(serde_json::json!({
            "name": name,
            "path": path.to_string_lossy().to_string(),
            "isDir": is_dir,
            "description": description,
            "mtime": mtime,
            "size": size,
        }));
    }
    result.sort_by(|a, b| {
        a.get("name").and_then(|v| v.as_str()).unwrap_or("")
            .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or(""))
    });
    Ok(result)
}

/// 安装扩展：将源路径（文件或目录）复制到 extensions 目录
#[tauri::command]
async fn install_extension(source_path: String) -> Result<serde_json::Value, String> {
    let ext_dir = get_extensions_dir()?;
    let src = std::path::Path::new(&source_path);
    if !src.exists() {
        return Err(format!("源路径不存在：{source_path}"));
    }
    let name = src.file_name()
        .and_then(|n| n.to_str())
        .ok_or("无效的源路径")?
        .to_string();
    let dst = ext_dir.join(&name);
    if dst.exists() {
        return Err(format!("扩展已存在：{name}，请先删除旧版本"));
    }
    let is_dir = src.is_dir();
    if is_dir {
        copy_dir_all(src, &dst)?;
    } else {
        std::fs::copy(src, &dst).map_err(|e| format!("复制文件失败：{e}"))?;
    }
    Ok(serde_json::json!({
        "name": name,
        "path": dst.to_string_lossy().to_string(),
        "isDir": is_dir,
    }))
}

/// 卸载扩展：删除 extensions 目录下的指定扩展
#[tauri::command]
async fn uninstall_extension(name: String) -> Result<(), String> {
    let ext_dir = get_extensions_dir()?;
    // 安全校验：name 不能包含路径分隔符，防止路径穿越
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("无效的扩展名称".into());
    }
    let target = ext_dir.join(&name);
    if !target.exists() {
        return Err(format!("扩展不存在：{name}"));
    }
    if target.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("删除扩展目录失败：{e}"))?;
    } else {
        std::fs::remove_file(&target).map_err(|e| format!("删除扩展文件失败：{e}"))?;
    }
    Ok(())
}

// ============================ 模型配置管理 ============================
//
// 直接读写 Pi 原生的 ~/.pi/agent/models.json，不再维护独立的 model-config.json。
// Pi 通过 models.json 注册自定义 provider 和模型（官方文档 pi.dev/docs/latest/models）。
// apiKey 字段用 ${ENV_VAR} 语法引用环境变量，apply_models_config 负责注入实际值。
//
// 默认模板：首次加载时若 models.json 不存在，用内置模板初始化，包含常用 provider
// 的预设 baseUrl/api/模型列表，但 apiKey 留空（用户填后保存才生效）。

/// models.json 文件路径
fn get_models_json_path() -> Result<std::path::PathBuf, String> {
    let agent = get_agent_dir().ok_or("找不到 agent 目录")?;
    Ok(agent.join("models.json"))
}

/// Pi 0.80.7 在回答结束计算用量时会直接读取 model.cost.tiers。
/// 旧版工作台创建的自定义模型没有 cost，导致回答已经生成后仍在收尾阶段报错。
fn normalize_models_config(config: &mut serde_json::Value) -> bool {
    let Some(providers) = config.get_mut("providers").and_then(|value| value.as_object_mut()) else {
        return false;
    };
    let mut changed = false;
    for provider in providers.values_mut() {
        let Some(models) = provider.get_mut("models").and_then(|value| value.as_array_mut()) else {
            continue;
        };
        for model in models {
            let Some(model) = model.as_object_mut() else { continue };
            if !model.get("cost").is_some_and(|value| value.is_object()) {
                model.insert("cost".into(), serde_json::json!({
                    "input": 0,
                    "output": 0,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "tiers": []
                }));
                changed = true;
                continue;
            }
            let cost = model.get_mut("cost").and_then(|value| value.as_object_mut()).unwrap();
            for key in ["input", "output", "cacheRead", "cacheWrite"] {
                if !cost.contains_key(key) {
                    cost.insert(key.into(), serde_json::json!(0));
                    changed = true;
                }
            }
            if !cost.get("tiers").is_some_and(|value| value.is_array()) {
                cost.insert("tiers".into(), serde_json::json!([]));
                changed = true;
            }
        }
    }
    changed
}

fn write_models_config(path: &std::path::Path, config: &serde_json::Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, content).map_err(|e| format!("写入 models.json 失败：{e}"))
}

/// 生成默认的 models.json 模板（首次使用时）
fn default_models_json() -> serde_json::Value {
    serde_json::json!({
        "providers": {
            "anthropic": {
                "baseUrl": "https://api.anthropic.com",
                "api": "anthropic",
                "apiKey": "$ANTHROPIC_API_KEY",
                "models": [
                    { "id": "claude-sonnet-4-5-20250929", "name": "Claude Sonnet 4.5" },
                    { "id": "claude-opus-4-1-20250805", "name": "Claude Opus 4.1" },
                    { "id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5" }
                ]
            },
            "deepseek": {
                "baseUrl": "https://api.deepseek.com",
                "api": "openai-completions",
                "apiKey": "$DEEPSEEK_API_KEY",
                "models": [
                    { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash" },
                    { "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro" }
                ]
            },
            "openai": {
                "baseUrl": "https://api.openai.com/v1",
                "api": "openai-completions",
                "apiKey": "$OPENAI_API_KEY",
                "models": [
                    { "id": "gpt-4.1", "name": "GPT-4.1" },
                    { "id": "gpt-4.1-mini", "name": "GPT-4.1 Mini" },
                    { "id": "gpt-4o", "name": "GPT-4o" }
                ]
            },
            "google": {
                "baseUrl": "https://generativelanguage.googleapis.com",
                "api": "google",
                "apiKey": "$GOOGLE_API_KEY",
                "models": [
                    { "id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash" },
                    { "id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro" }
                ]
            },
            "openrouter": {
                "baseUrl": "https://openrouter.ai/api/v1",
                "api": "openai-completions",
                "apiKey": "$OPENROUTER_API_KEY",
                "models": [
                    { "id": "anthropic/claude-sonnet-4.5", "name": "Claude Sonnet 4.5 (via OpenRouter)" },
                    { "id": "openai/gpt-4.1", "name": "GPT-4.1 (via OpenRouter)" },
                    { "id": "deepseek/deepseek-v4-flash", "name": "DeepSeek V4 Flash (via OpenRouter)" }
                ]
            },
            "siliconflow": {
                "baseUrl": "https://api.siliconflow.cn/v1",
                "api": "openai-completions",
                "apiKey": "$SILICONFLOW_API_KEY",
                "models": [
                    { "id": "deepseek-ai/DeepSeek-V4-Flash", "name": "DeepSeek V4 Flash" },
                    { "id": "deepseek-ai/DeepSeek-V4-Pro", "name": "DeepSeek V4 Pro" },
                    { "id": "zai-org/GLM-5.1", "name": "GLM-5.1" },
                    { "id": "Qwen/Qwen3-235B-A22B-Instruct", "name": "Qwen3 235B" }
                ]
            },
            "custom": {
                "baseUrl": "",
                "api": "openai-completions",
                "apiKey": "$CUSTOM_API_KEY",
                "models": []
            }
        }
    })
}

/// 读取 Pi 的 models.json
///
/// 若文件不存在，返回默认模板并写入磁盘。
/// 若存在旧的 model-config.json（上一版壳子的配置），尝试迁移 apiKey 字段。
#[tauri::command]
async fn get_models_config() -> Result<serde_json::Value, String> {
    let path = get_models_json_path()?;
    if !path.exists() {
        let mut default = default_models_json();
        normalize_models_config(&mut default);
        // 写入默认模板，方便用户直接编辑
        let agent_dir = path.parent().ok_or("无效的路径")?;
        if !agent_dir.exists() {
            std::fs::create_dir_all(agent_dir).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        let _ = write_models_config(&path, &default);
        return Ok(default);
    }
    let content = std::fs::read_to_string(&path).map_err(|e| format!("读取 models.json 失败：{e}"))?;
    let mut val: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("解析 models.json 失败：{e}"))?;
    if normalize_models_config(&mut val) {
        write_models_config(&path, &val)?;
    }
    Ok(val)
}

/// 保存 Pi 的 models.json
#[tauri::command]
async fn save_models_config(mut config: serde_json::Value) -> Result<(), String> {
    let path = get_models_json_path()?;
    let agent_dir = path.parent().ok_or("无效的路径")?;
    if !agent_dir.exists() {
        std::fs::create_dir_all(agent_dir).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    normalize_models_config(&mut config);
    write_models_config(&path, &config)
}

/// 应用 models.json 中的 API Key 到环境变量
///
/// 扫描 models.json 中所有 provider 的 apiKey 字段，若值为 ${ENV_VAR} 格式，
/// 从环境变量读取实际值（不在此设置，由前端保存时写入对应的 .env 或由用户系统配置）。
/// 若值为明文（不以 $ 开头），直接设为环境变量。
///
/// 注意：Pi 子进程在 spawn 时继承当前进程环境变量，所以修改后需 restart_pi 才生效。
#[tauri::command]
async fn apply_models_config() -> Result<String, String> {
    apply_models_config_inner()
}

/// 同步版本（供 setup 调用）
fn apply_models_config_sync() -> Result<String, String> {
    apply_models_config_inner()
}

fn apply_models_config_inner() -> Result<String, String> {
    let path = get_models_json_path()?;
    if !path.exists() {
        return Ok("无 models.json 可应用".into());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| format!("读取 models.json 失败：{e}"))?;
    let mut config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("解析 models.json 失败：{e}"))?;
    if normalize_models_config(&mut config) {
        write_models_config(&path, &config)?;
    }

    let mut applied = Vec::new();
    if let Some(providers) = config.get("providers").and_then(|v| v.as_object()) {
        for (id, provider) in providers {
            // provider 必须有 models 且非空才视为"已配置"
            let models = provider.get("models").and_then(|m| m.as_array());
            if models.map_or(true, |m| m.is_empty()) {
                continue;
            }
            let api_key = provider.get("apiKey").and_then(|v| v.as_str()).unwrap_or("");
            if api_key.is_empty() {
                continue;
            }
            // apiKey 格式：$ENV_VAR 或明文 key
            // 明文 key 时设置 <ID>_API_KEY 环境变量（如 SILICONFLOW_API_KEY），
            // 这样 models.json 里 apiKey="$SILICONFLOW_API_KEY" 的引用能解析到实际值。
            let (env_name, actual_key) = if let Some(stripped) = api_key.strip_prefix('$') {
                // ${ENV_VAR} 格式：从环境变量读实际值
                let var_name = stripped.trim_start_matches('{').trim_end_matches('}');
                match std::env::var(var_name) {
                    Ok(val) if !val.is_empty() => (var_name.to_string(), val),
                    _ => continue, // 环境变量未设置，跳过
                }
            } else {
                // 明文 key：设置 <ID>_API_KEY 环境变量
                (format!("{}_API_KEY", id.to_uppercase()), api_key.to_string())
            };
            std::env::set_var(&env_name, &actual_key);
            applied.push(id.clone());
        }
    }

    if applied.is_empty() {
        Ok("没有已配置的提供商".into())
    } else {
        Ok(format!("已应用：{}", applied.join("、")))
    }
}

/// 测试模型连接是否可用（验证 API Key 是否有效）。
///
/// 发一个最小的 chat completion 请求（max_tokens=1）到 provider 的 API，
/// 根据 HTTP 状态码判断 key 是否有效：
/// - 200：key 有效，返回成功
/// - 401/403：key 无效或权限不足
/// - 404：base_url 或 model 名错误
/// - 其他：返回错误信息供用户排查
///
/// 支持两种 API 格式：
/// - OpenAI 兼容（DeepSeek/OpenAI/Gemini/OpenRouter/Groq/Mistral）：POST /chat/completions
/// - Anthropic：POST /v1/messages（header 格式不同，用 x-api-key）
#[tauri::command]
async fn test_model_connection(provider_id: String, api_key: String, base_url: Option<String>, model: Option<String>) -> Result<serde_json::Value, String> {
    if api_key.is_empty() {
        return Err("API Key 为空".into());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    // 根据 provider 决定 URL、header 格式、body
    let (url, header_kind, body) = match provider_id.as_str() {
        "anthropic" => {
            let base = base_url.as_deref().unwrap_or("https://api.anthropic.com");
            let url = format!("{}/v1/messages", base.trim_end_matches('/'));
            let model_name = model.as_deref().unwrap_or("claude-sonnet-4-5-20250929");
            let body = serde_json::json!({
                "model": model_name,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}]
            });
            (url, "anthropic", body)
        }
        "deepseek" => {
            // DeepSeek: https://api.deepseek.com/chat/completions (OpenAI 兼容)
            let base = base_url.as_deref().unwrap_or("https://api.deepseek.com");
            let url = format!("{}/chat/completions", base.trim_end_matches('/'));
            let model_name = model.as_deref().unwrap_or("deepseek-v4-flash");
            let body = serde_json::json!({
                "model": model_name,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}]
            });
            (url, "openai", body)
        }
        "openai" => {
            let base = base_url.as_deref().unwrap_or("https://api.openai.com");
            let url = format!("{}/v1/chat/completions", base.trim_end_matches('/'));
            let model_name = model.as_deref().unwrap_or("gpt-4.1-mini");
            let body = serde_json::json!({
                "model": model_name,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}]
            });
            (url, "openai", body)
        }
        "google" | "gemini" => {
            // Gemini OpenAI 兼容端点
            let base = base_url.as_deref().unwrap_or("https://generativelanguage.googleapis.com");
            let url = format!("{}/v1beta/openai/chat/completions", base.trim_end_matches('/'));
            let model_name = model.as_deref().unwrap_or("gemini-2.5-flash");
            let body = serde_json::json!({
                "model": model_name,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}]
            });
            (url, "openai", body)
        }
        "openrouter" => {
            let base = base_url.as_deref().unwrap_or("https://openrouter.ai/api/v1");
            let url = format!("{}/chat/completions", base.trim_end_matches('/'));
            let model_name = model.as_deref().unwrap_or("openai/gpt-4.1-mini");
            let body = serde_json::json!({
                "model": model_name,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}]
            });
            (url, "openai", body)
        }
        "mistral" => {
            let base = base_url.as_deref().unwrap_or("https://api.mistral.ai");
            let url = format!("{}/v1/chat/completions", base.trim_end_matches('/'));
            let model_name = model.as_deref().unwrap_or("mistral-small-latest");
            let body = serde_json::json!({
                "model": model_name,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}]
            });
            (url, "openai", body)
        }
        "groq" => {
            let base = base_url.as_deref().unwrap_or("https://api.groq.com/openai");
            let url = format!("{}/v1/chat/completions", base.trim_end_matches('/'));
            let model_name = model.as_deref().unwrap_or("llama-3.3-70b-versatile");
            let body = serde_json::json!({
                "model": model_name,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}]
            });
            (url, "openai", body)
        }
        "siliconflow" => {
            // 硅基流动：OpenAI 兼容，base_url 为 https://api.siliconflow.cn/v1
            let base = base_url.as_deref().unwrap_or("https://api.siliconflow.cn/v1");
            let url = format!("{}/chat/completions", base.trim_end_matches('/'));
            let model_name = model.as_deref().unwrap_or("deepseek-ai/DeepSeek-V4-Flash");
            let body = serde_json::json!({
                "model": model_name,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}]
            });
            (url, "openai", body)
        }
        "custom" => {
            // 自定义地址：用户必须填 base_url 和 model，按 OpenAI 兼容格式请求。
            // base_url 应包含到 /v1 或等价路径，拼 /chat/completions。
            let base = match base_url.as_deref() {
                Some(b) if !b.trim().is_empty() => b.trim_end_matches('/'),
                _ => return Err("自定义地址必须填写 Base URL".into()),
            };
            let model_name = match model {
                Some(m) if !m.trim().is_empty() => m,
                _ => return Err("自定义地址必须选择测试连接模型".into()),
            };
            let url = format!("{}/chat/completions", base);
            let body = serde_json::json!({
                "model": model_name,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "hi"}]
            });
            (url, "openai", body)
        }
        _ => return Err(format!("不支持的 provider: {provider_id}")),
    };

    // 构造请求
    let mut req = client.post(&url).json(&body);
    match header_kind {
        "anthropic" => {
            req = req
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json");
        }
        _ => {
            req = req
                .header("Authorization", format!("Bearer {api_key}"))
                .header("content-type", "application/json");
        }
    }

    let resp = req.send().await.map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();

    if status == 200 {
        // 解析返回的模型名（如果有）让用户确认生效的模型
        let returned_model = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()));
        Ok(serde_json::json!({
            "success": true,
            "status": status,
            "model": returned_model,
            "message": "连接成功，API Key 有效"
        }))
    } else {
        // 尝试提取 error.message
        let err_msg = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message").and_then(|m| m.as_str()).map(|s| s.to_string()))
                    .or_else(|| v.get("message").and_then(|m| m.as_str()).map(|s| s.to_string()))
            })
            .unwrap_or_else(|| {
                if text.len() > 200 { format!("{}...", &text[..200]) } else { text.clone() }
            });
        let hint = match status {
            401 => "API Key 无效或已过期",
            403 => "API Key 权限不足，或触发了内容审核",
            404 => "base_url 或 model 名错误",
            429 => "请求过于频繁或余额不足",
            _ => "",
        };
        Ok(serde_json::json!({
            "success": false,
            "status": status,
            "message": err_msg,
            "hint": hint
        }))
    }
}

#[tauri::command]
async fn stop_pi(state: State<'_, PiState>) -> Result<(), String> {
    stop_pi_inner(state.inner());
    Ok(())
}

// ============================ Python 工具 sidecar ============================

/// 定位 Python sidecar 的工作目录与启动方式。
///
/// 解析顺序（先命中先用）：
///   1. 打包后 resource_dir 下的 ht-sidecar[.exe]（两种打包位置都支持）：
///      a. resource_dir/ht-sidecar[.exe]（tauri.conf.json `"./"` 配置时的实际位置）
///      b. resource_dir/python-sidecar/ht-sidecar[.exe]（兼容 `"./python-sidecar/"` 配置）
///   2. 开发模式：仓库根的 `python-sidecar/` 目录 + 系统 python
/// 两者都失败返回 Err，调用方据此降级（前端提示用户手动启动 sidecar）。
fn resolve_sidecar(resource_dir: Option<&std::path::Path>) -> Result<(Command, std::path::PathBuf), String> {
    let exe_name = if cfg!(windows) { "ht-sidecar.exe" } else { "ht-sidecar" };

    // 1. 打包后：在 resource_dir 下查找 ht-sidecar exe
    if let Some(rd) = resource_dir {
        // 1a. resource 根目录（当前 tauri.conf.json "../../python-sidecar/ht-sidecar*": "./" 的实际位置）
        let exe_root = rd.join(exe_name);
        if exe_root.is_file() {
            let mut cmd = Command::new(&exe_root);
            // 工作目录设为 resource_dir：PyInstaller onefile exe 的依赖在 _MEIPASS 临时目录，
            // cwd 主要影响 main.py 里可能的相对路径读取（如 tools/templates/）。
            // 打包后 templates 已在 _MEIPASS 内，cwd 影响不大，但保持与原 python-sidecar/ 一致
            // 的语义，设为 exe 所在目录。
            cmd.current_dir(rd);
            eprintln!("[sidecar] 使用打包 exe: {} (cwd: {})", exe_root.display(), rd.display());
            return Ok((cmd, rd.to_path_buf()));
        }
        // 1b. resource/python-sidecar/ 子目录（兼容旧配置或显式打到子目录的情况）
        let ps_dir = rd.join("python-sidecar");
        let exe_sub = ps_dir.join(exe_name);
        if exe_sub.is_file() {
            let mut cmd = Command::new(&exe_sub);
            cmd.current_dir(&ps_dir);
            eprintln!("[sidecar] 使用打包 exe: {} (cwd: {})", exe_sub.display(), ps_dir.display());
            return Ok((cmd, ps_dir));
        }
    }

    // 1c. 兜底：current_exe 同级直接查 ht-sidecar exe
    //     NSIS perMachine 安装时资源就在 exe 同目录（如 D:\Program Files\HT Logistic Agent\），
    //     但某些 Tauri 版本/配置下 resource_dir() 可能返回意外路径（如 resources/ 子目录），
    //     此时 current_exe 同级是最可靠的定位方式。
    //     向上查 4 级覆盖 exe 在 bin/ 子目录的少数情况。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let mut cur: Option<&std::path::Path> = Some(exe_dir);
            for _ in 0..4 {
                if let Some(d) = cur {
                    let exe_local = d.join(exe_name);
                    if exe_local.is_file() {
                        let mut cmd = Command::new(&exe_local);
                        cmd.current_dir(d);
                        eprintln!("[sidecar] 使用打包 exe (current_exe 兜底): {} (cwd: {})", exe_local.display(), d.display());
                        return Ok((cmd, d.to_path_buf()));
                    }
                    cur = d.parent();
                } else { break; }
            }
        }
    }

    // 2. 开发模式：基于当前可执行文件位置向上查找 python-sidecar/ 目录
    //    dev 模式下可执行文件在 src-tauri/target/debug/pi-assistant.exe，
    //    python-sidecar/ 在仓库根（即 target 的上 3 级：debug→target→src-tauri→repo-root）。
    //    候选路径：current_exe 向上 1~5 级 + resource_dir 向上 1~3 级 + 当前工作目录。
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let mut cur: Option<&std::path::Path> = Some(exe_dir);
            for _ in 0..6 {
                if let Some(d) = cur {
                    candidates.push(d.join("python-sidecar"));
                    cur = d.parent();
                } else { break; }
            }
        }
    }
    if let Some(rd) = resource_dir {
        let mut cur: Option<&std::path::Path> = Some(rd);
        for _ in 0..4 {
            if let Some(d) = cur {
                candidates.push(d.join("python-sidecar"));
                cur = d.parent();
            } else { break; }
        }
    }
    // 兜底：当前工作目录
    candidates.push(std::path::PathBuf::from("python-sidecar"));
    candidates.push(std::path::PathBuf::from("../python-sidecar"));

    eprintln!("[sidecar] 候选路径:");
    for c in &candidates {
        eprintln!("  -> {} (exists={}, has main.py={})",
            c.display(), c.is_dir(), c.join("main.py").is_file());
    }
    for ps_dir in candidates {
        if !ps_dir.is_dir() { continue; }
        if ps_dir.join("main.py").is_file() {
            // 优先用项目 venv 里的 python（.venv/Scripts/python.exe on Windows,
            // .venv/bin/python on Unix），因为依赖装在 venv 里，用系统 python
            // 会因 import 失败导致 sidecar 进程秒崩。
            // 没有 venv 才回退到系统 python（生产打包用 PyInstaller exe，
            // 走上面的 resource_dir 分支，不会到这里）。
            let venv_python = if cfg!(windows) {
                ps_dir.join(".venv").join("Scripts").join("python.exe")
            } else {
                ps_dir.join(".venv").join("bin").join("python")
            };
            let (py, using_venv) = if venv_python.is_file() {
                (venv_python.to_string_lossy().to_string(), true)
            } else {
                let fallback = if cfg!(windows) { "python" } else { "python3" };
                (fallback.to_string(), false)
            };
            eprintln!("[sidecar] 使用 python: {} ({})", py,
                if using_venv { "venv" } else { "系统 fallback" });
            let mut cmd = Command::new(&py);
            cmd.arg("main.py");
            cmd.current_dir(&ps_dir);
            eprintln!("[sidecar] 选中: {} (python {})", ps_dir.display(), py);
            return Ok((cmd, ps_dir));
        }
    }

    Err("未找到 python-sidecar。请先构建 PyInstaller exe，或在开发模式下从仓库根启动。".into())
}

/// 发 HTTP GET /api/health 验证 sidecar 是否真的在运行。
///
/// 仅 TCP 连通不够——端口可能被其它服务占用（如残留的 dev server），
/// 那种情况下工具 fetch 会打到错误服务。必须验证 HTTP 响应内容。
///
/// 用 std::net 手动发 HTTP 请求，避免引入 reqwest 依赖。
fn check_sidecar_health() -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let addr = format!("127.0.0.1:{SIDECAR_PORT}");
    let socket_addr: std::net::SocketAddr = match addr.parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&socket_addr, Duration::from_secs(2)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    // 读写都设超时，避免卡死
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));

    let req = b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(req).is_err() {
        return false;
    }
    let mut buf = String::new();
    if stream.read_to_string(&mut buf).is_err() {
        return false;
    }
    // sidecar /api/health 返回 {"ok":true}，检查 body 是否包含 "ok"
    // （不严格匹配 JSON，容错 sidecar 未来字段扩展）
    buf.contains("\"ok\"") && buf.contains("true")
}

/// 启动 Python sidecar。setup 时调用；不阻塞事件循环，后台线程轮询健康。
fn spawn_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    if state.child.lock().unwrap().is_some() {
        return; // 已启动
    }

    // 端口已占用检测：如果 127.0.0.1:8000 已经有服务响应 /api/health，
    // 说明用户手动起了 sidecar（或上次未清理），直接标记为就绪，不再拉起新进程。
    // 注意：必须发 HTTP 请求验证响应内容，仅 TCP 连通不够——端口可能被其它服务
    // （如残留的 dev server、其它应用）占用，那种情况下工具 fetch 会打到错误服务。
    if check_sidecar_health() {
        eprintln!("[sidecar] 端口 {} 已有 sidecar 响应，认定外部 sidecar 已就绪", SIDECAR_PORT);
        state.ready.store(true, Ordering::SeqCst);
        let _ = app.emit("sidecar-status", serde_json::json!({
            "ready": true, "url": SIDECAR_URL, "note": "外部 sidecar"
        }));
        return;
    }

    let resource_dir = app.path().resource_dir().ok();
    let (mut cmd, _ps_dir) = match resolve_sidecar(resource_dir.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[sidecar] 定位失败：{e}");
            let _ = app.emit("sidecar-status", serde_json::json!({
                "ready": false, "error": format!("定位 sidecar 失败：{e}"),
            }));
            return;
        }
    };

    // Windows 隐藏控制台窗（与 pi 一致，避免黑窗干扰）
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    match cmd.spawn() {
        Ok(child) => {
            *state.child.lock().unwrap() = Some(child);
        }
        Err(e) => {
            eprintln!("[sidecar] 启动失败：{e}");
            let _ = app.emit("sidecar-status", serde_json::json!({
                "ready": false, "error": format!("启动 sidecar 失败：{e}"),
            }));
            return;
        }
    }

    // 后台线程轮询 /api/health：HTTP 响应 {"ok":true} 才认为就绪。
    // 不用纯 TCP 连通——端口可能被其它服务占用，那种情况下工具 fetch 会失败。
    let app2 = app.clone();
    std::thread::spawn(move || {
        for _ in 0..30 { // 最多等 ~15s（30 × 500ms）
            if check_sidecar_health() {
                if let Some(state) = app2.try_state::<SidecarState>() {
                    state.ready.store(true, Ordering::SeqCst);
                }
                let _ = app2.emit("sidecar-status", serde_json::json!({ "ready": true, "url": SIDECAR_URL }));
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        let _ = app2.emit("sidecar-status", serde_json::json!({
            "ready": false, "error": "sidecar 启动后 15s 内 /api/health 未就绪",
        }));
    });
}

#[tauri::command]
async fn sidecar_url() -> Result<String, String> {
    Ok(SIDECAR_URL.to_string())
}

#[tauri::command]
async fn sidecar_status(state: State<'_, SidecarState>) -> Result<serde_json::Value, String> {
    let running = state.child.lock().unwrap().is_some();
    let ready = state.ready.load(Ordering::SeqCst);
    Ok(serde_json::json!({ "running": running, "ready": ready, "url": SIDECAR_URL }))
}

#[tauri::command]
async fn stop_sidecar(state: State<'_, SidecarState>) -> Result<(), String> {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    state.ready.store(false, Ordering::SeqCst);
    Ok(())
}

/// 写二进制文件（工具结果保存用）。前端 invoke("write_binary_file", { path, data })
/// data 是 number[]（从 Uint8Array 转换），Rust 端转回 Vec<u8> 写盘。
#[tauri::command]
async fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data).map_err(|e| format!("写入文件失败：{e}"))
}

/// 在文件管理器中显示文件（Windows: explorer /select; macOS: open -R; Linux: xdg-open）
#[tauri::command]
async fn open_in_explorer(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在：{path}"));
    }
    #[cfg(target_os = "windows")]
    {
        // explorer /select,<path> 会打开资源管理器并选中该文件
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("打开资源管理器失败：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("打开 Finder 失败：{e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Linux：打开文件所在目录
        let dir = p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_else(|| ".".into());
        Command::new("xdg-open").arg(&dir).spawn()
            .map_err(|e| format!("打开文件管理器失败：{e}"))?;
    }
    Ok(())
}

/// 打开更新下载文件夹。
///
/// Tauri updater 下载的 setup.exe 存放在系统临时目录（Windows: %TEMP%）。
/// 如果安装失败（如 "无法打开要写入的文件 ht-sidecar"），下载的安装包
/// 可能还在临时目录里，用户可以手动找到并重新运行。
///
/// 本命令搜索 %TEMP%（递归 2 层，覆盖 Tauri 的 .tmpXXXXXX/ 子目录）
/// 找最新的 *-setup.exe，用 explorer /select 选中它；没找到则打开 %TEMP% 本身。
#[tauri::command]
async fn open_update_folder() -> Result<String, String> {
    let temp_dir = std::env::temp_dir();

    // 递归搜索 temp_dir 下（最多 2 层深）所有 *-setup.exe，
    // 按修改时间排序取最新的。Tauri updater 下载路径形如
    // %TEMP%\.tmpXXXXXX\HT Logistic Agent_0.1.x_x64-setup.exe
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;

    fn scan_dir(dir: &std::path::Path, depth: u32, newest: &mut Option<(std::time::SystemTime, std::path::PathBuf)>) {
        if depth > 2 { return; }
        let entries = match std::fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // 跳过明显无关的目录，减少扫描时间
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if name.starts_with('.') || name.starts_with("pip-") || name.starts_with("rust") {
                    // .tmpXXXXXX 目录要扫（Tauri 下载在这），其他 . 开头的也扫
                }
                scan_dir(&path, depth + 1, newest);
            } else if path.is_file() {
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if name.ends_with("-setup.exe") || name.contains("setup") && name.ends_with(".exe") {
                    if let Ok(meta) = entry.metadata() {
                        if let Ok(mtime) = meta.modified() {
                            match newest {
                                Some((cur_time, _)) if &mtime <= cur_time => {}
                                _ => *newest = Some((mtime, path.clone())),
                            }
                        }
                    }
                }
            }
        }
    }
    scan_dir(&temp_dir, 0, &mut newest);

    #[cfg(target_os = "windows")]
    {
        if let Some((_, ref path)) = newest {
            let path_str = path.to_string_lossy().to_string();
            Command::new("explorer")
                .args(["/select,", &path_str])
                .spawn()
                .map_err(|e| format!("打开资源管理器失败：{e}"))?;
            return Ok(format!("已找到下载的安装包并打开所在文件夹：{}", path_str));
        }
        // 没找到 setup.exe，直接打开 %TEMP%
        let temp_str = temp_dir.to_string_lossy().to_string();
        Command::new("explorer").arg(&temp_str).spawn()
            .map_err(|e| format!("打开临时文件夹失败：{e}"))?;
        return Ok(format!("未找到已下载的安装包，已打开临时文件夹：{}", temp_str));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let dir = newest.as_ref()
            .and_then(|(_, p)| p.parent())
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_else(|| temp_dir.to_string_lossy().to_string());
        Command::new("xdg-open").arg(&dir).spawn()
            .map_err(|e| format!("打开文件管理器失败：{e}"))?;
        Ok(format!("已打开更新文件夹：{}", dir))
    }
}

/// 目录条目信息
#[derive(serde::Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: f64,
}

/// 列出目录内容（用于文件浏览器）
/// 排序：目录在前，然后按名称排序
#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let dir = std::path::Path::new(&path);
    if !dir.exists() {
        return Err(format!("目录不存在：{path}"));
    }
    if !dir.is_dir() {
        return Err(format!("不是目录：{path}"));
    }
    let entries = std::fs::read_dir(dir).map_err(|e| format!("读取目录失败：{e}"))?;
    let mut result: Vec<DirEntryInfo> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败：{e}"))?;
        let meta = entry.metadata().map_err(|e| format!("读取元数据失败：{e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        // 跳过隐藏文件（以 . 开头）
        if name.starts_with('.') {
            continue;
        }
        let modified = meta.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        result.push(DirEntryInfo {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified,
        });
    }
    // 排序：目录优先，然后按名称（不区分大小写）
    result.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });
    Ok(result)
}

/// 用系统默认程序打开文件
#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("文件不存在：{path}"));
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd").args(["/C", "start", "", &path]).spawn()
            .map_err(|e| format!("打开文件失败：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(&path).spawn()
            .map_err(|e| format!("打开文件失败：{e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(&path).spawn()
            .map_err(|e| format!("打开文件失败：{e}"))?;
    }
    Ok(())
}

/// 获取 agent 相关目录路径（用于文件浏览器初始定位）
#[tauri::command]
async fn get_agent_paths() -> Result<serde_json::Value, String> {
    let agent = get_agent_dir().ok_or("找不到 agent 目录")?;
    let home = dirs::home_dir().ok_or("找不到主目录")?;
    Ok(serde_json::json!({
        "home": home.to_string_lossy().to_string(),
        "agent": agent.to_string_lossy().to_string(),
        "sessions": agent.join("sessions").to_string_lossy().to_string(),
        "extensions": agent.join("extensions").to_string_lossy().to_string(),
        "skills": agent.join("skills").to_string_lossy().to_string(),
    }))
}

/// 检查路径是否存在（文件或目录均可）。供前端在 restart_pi 前预校验 workdir/sessionPath。
#[tauri::command]
async fn path_exists(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).exists())
}

#[cfg(test)]
mod tests {
    use super::normalize_models_config;

    #[test]
    fn model_config_normalization_adds_safe_cost_defaults() {
        let mut config = serde_json::json!({
            "providers": {
                "custom": {
                    "models": [{ "id": "demo", "name": "Demo" }]
                }
            }
        });

        assert!(normalize_models_config(&mut config));
        assert_eq!(config["providers"]["custom"]["models"][0]["cost"]["input"], 0);
        assert_eq!(config["providers"]["custom"]["models"][0]["cost"]["tiers"], serde_json::json!([]));
        assert!(!normalize_models_config(&mut config));
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PiState {
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            response_channels: Arc::new(Mutex::new(HashMap::new())),
            next_request_id: AtomicU64::new(1),
            process_gen: AtomicU64::new(0),
        })
        .manage(SidecarState {
            child: Mutex::new(None),
            ready: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            start_pi, stop_pi, restart_pi, send_command, send_request, scan_sessions, delete_session, check_env_keys, read_text_file, write_text_file, read_session_history,
            sidecar_url, sidecar_status, stop_sidecar,
            write_binary_file, open_in_explorer, open_update_folder,
            list_extensions, install_extension, uninstall_extension,
            get_models_config, save_models_config, apply_models_config, test_model_connection,
            list_dir, open_file, get_agent_paths, path_exists
        ])
        .setup(|app| {
            // 启动前先应用模型配置（把 API Key 注入环境变量）
            let _ = apply_models_config_sync();
            // 启动 Python 工具 sidecar（不阻塞，后台轮询健康后 emit sidecar-status）
            spawn_sidecar(app.handle());
            #[cfg(debug_assertions)]
            {
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 窗口关闭时清理所有子进程（sidecar + pi），避免残留进程：
            // - uvicorn 残留会占用 8000 端口，下次启动 sidecar 健康检查误判
            // - pi (node.exe) 残留会占用会话文件，且更新安装时锁住 pi-runtime 文件
            //   导致 NSIS "无法打开要写入的文件" 错误
            if let WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle();
                // 杀 pi
                if let Some(state) = app.try_state::<PiState>() {
                    stop_pi_inner(state.inner());
                }
                // 杀 sidecar
                if let Some(state) = app.try_state::<SidecarState>() {
                    if let Some(mut child) = state.child.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
