#!/usr/bin/env bash
# HT Logistic Workspace — 一键打包傻瓜安装器脚本（macOS / Linux bash）
#
# 用法：
#   cd ht-logistic-workspace-v2
#   bash scripts/build-installer.sh
#
# 产物（用户双击即可安装，无需装 Node.js / Python / Rust）：
#   macOS: tauri-app/src-tauri/target/release/bundle/dmg/*.dmg
#   Linux: tauri-app/src-tauri/target/release/bundle/deb/*.deb + appimage/*.AppImage
#
# 流程：
#   1. 打包 Python sidecar（PyInstaller → ht-sidecar）
#   2. 准备 pi-runtime（下载便携版 Node.js + npm 装 pi 包 + 生成 pi 启动脚本）
#   3. npm install + npm run tauri build（把 sidecar + pi-runtime 一起打包）
#   4. 输出产物路径

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIDECAR_DIR="$REPO_ROOT/python-sidecar"
TAURI_DIR="$REPO_ROOT/tauri-app"
PI_RUNTIME_DIR="$REPO_ROOT/pi-runtime"

echo -e "\033[36m================================================\033[0m"
echo -e "\033[36m  HT Logistic Workspace 傻瓜安装器打包\033[0m"
echo -e "\033[36m================================================\033[0m"
echo ""

# ---------- 1. 打包 Python sidecar ----------
echo -e "\033[33m[1/4] 打包 Python sidecar...\033[0m"
cd "$SIDECAR_DIR"
if [ ! -d ".venv" ]; then
    echo "  创建 venv..."
    python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -r requirements.txt --quiet
pip install pyinstaller --quiet
echo "  运行 PyInstaller..."
pyinstaller ht-sidecar.spec --noconfirm --clean > /dev/null 2>&1
if [ ! -f "dist/ht-sidecar" ]; then
    echo "PyInstaller 打包失败" >&2; exit 1
fi
cp "dist/ht-sidecar" "ht-sidecar"
chmod +x "ht-sidecar"
echo -e "  sidecar 已就位 \033[32m✓\033[0m"

# ---------- 2. 准备 pi-runtime（便携 Node + pi 包）----------
echo ""
echo -e "\033[33m[2/4] 准备 pi-runtime（便携版 Node.js + pi 包）...\033[0m"

PI_PACKAGE_VERSION=$(node -p "require('$TAURI_DIR/package.json').devDependencies['@earendil-works/pi-coding-agent']")
if [ -z "$PI_PACKAGE_VERSION" ] || [ "$PI_PACKAGE_VERSION" = "undefined" ]; then
    echo "tauri-app/package.json 中缺少 Pi 版本" >&2; exit 1
fi
PI_PACKAGE_SPEC="@earendil-works/pi-coding-agent@$PI_PACKAGE_VERSION"

rm -rf "$PI_RUNTIME_DIR"
mkdir -p "$PI_RUNTIME_DIR"

# 2a. 下载便携版 Node.js
NODE_VERSION="v22.20.0"
OS_TYPE="$(uname -s)"
ARCH_TYPE="$(uname -m)"
case "$OS_TYPE" in
    Darwin) NODE_OS="darwin";;
    Linux)  NODE_OS="linux";;
    *) echo "不支持的系统: $OS_TYPE" >&2; exit 1;;
esac
case "$ARCH_TYPE" in
    x86_64|amd64) NODE_ARCH="x64";;
    arm64|aarch64) NODE_ARCH="arm64";;
    *) echo "不支持的架构: $ARCH_TYPE" >&2; exit 1;;
esac
NODE_TARBALL="node-$NODE_VERSION-$NODE_OS-$NODE_ARCH.tar.xz"
NODE_URL="https://nodejs.org/dist/$NODE_VERSION/$NODE_TARBALL"
NODE_TMP="$(mktemp -d)"

echo "  下载 Node.js $NODE_VERSION ($NODE_OS-$NODE_ARCH)..."
curl -fsSL "$NODE_URL" | tar -xJ -C "$NODE_TMP"
NODE_BIN_DIR=$(find "$NODE_TMP" -name "node" -type f -executable | head -1 | xargs dirname)
cp "$NODE_BIN_DIR/node" "$PI_RUNTIME_DIR/node"
chmod +x "$PI_RUNTIME_DIR/node"

# 2b. 用便携 node 跑 npm 装 pi 包
echo "  安装 pi 包到 pi-runtime..."
NPM_CLI=$(find "$NODE_TMP" -path "*/npm/bin/npm-cli.js" | head -1)
echo '{"name":"pi-runtime","version":"1.0.0","private":true}' > "$PI_RUNTIME_DIR/package.json"
cd "$PI_RUNTIME_DIR"
"$PI_RUNTIME_DIR/node" "$NPM_CLI" install "$PI_PACKAGE_SPEC" --no-save --ignore-scripts > /dev/null 2>&1
if [ ! -d "node_modules/@earendil-works/pi-coding-agent" ]; then
    echo "pi 包安装失败" >&2; exit 1
fi

# 2c. 生成 pi 启动脚本
PI_CLI_JS="node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
cat > "$PI_RUNTIME_DIR/pi" << EOF
#!/usr/bin/env bash
# pi 启动脚本（便携版，调用内嵌 node 运行 pi）
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
export PATH="\$DIR:\$PATH"
exec "\$DIR/node" "\$DIR/$PI_CLI_JS" "\$@"
EOF
chmod +x "$PI_RUNTIME_DIR/pi"
echo -e "  pi 启动脚本已生成 \033[32m✓\033[0m"

# 2d. 清理多余文件，减小体积
rm -f "$PI_RUNTIME_DIR/package.json" "$PI_RUNTIME_DIR/package-lock.json"
find "$PI_RUNTIME_DIR" -name "*.md" -delete 2>/dev/null || true
find "$PI_RUNTIME_DIR" -name "*.map" -delete 2>/dev/null || true
find "$PI_RUNTIME_DIR" -name "*.markdown" -delete 2>/dev/null || true
rm -rf "$NODE_TMP"

RUNTIME_SIZE=$(du -sh "$PI_RUNTIME_DIR" | cut -f1)
echo -e "  pi-runtime 准备完成（约 ${RUNTIME_SIZE}）\033[32m✓\033[0m"

# ---------- 3. 清理 sidecar + 构建 Tauri ----------
echo ""
echo -e "\033[33m[3/4] 清理 + 构建 Tauri 安装器...\033[0m"

# 3a. 校验 updater 签名密钥（未配置则警告，但仍继续构建）
#     NOTE: Tauri v2 官方环境变量名是 TAURI_SIGNING_PRIVATE_KEY 和
#     TAURI_SIGNING_PRIVATE_KEY_PASSWORD（见 v2.tauri.app/reference/environment-variables）。
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    echo ""
    echo -e "\033[31mWARNING: TAURI_SIGNING_PRIVATE_KEY 环境变量未设置。\033[0m"
    echo -e "\033[33m  没有签名密钥，updater 的 .sig 文件不会生成，自动更新会失败签名校验。\033[0m"
    echo -e "\033[33m  生成密钥对：\033[0m"
    echo "    npm run tauri signer generate -- -w \$HOME/.tauri/ht-logistic.key"
    echo -e "\033[33m  构建前设置：\033[0m"
    echo "    export TAURI_SIGNING_PRIVATE_KEY=\$(cat \$HOME/.tauri/ht-logistic.key)"
    echo "    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='your-password-if-set'"
    echo -e "\033[33m  继续构建（不带 updater 签名，自动更新不可用）...\033[0m"
    echo ""
fi

cd "$SIDECAR_DIR"
for d in build dist __pycache__ .pytest_cache; do
    [ -d "$d" ] && rm -rf "$d"
done
find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

cd "$TAURI_DIR"
npm install --silent
npm run tauri build

# ---------- 4. 生成 latest.json + 打印上传清单 ----------
echo ""
echo -e "\033[32m[4/4] 构建完成！生成 updater manifest...\033[0m"
BUNDLE_DIR="$TAURI_DIR/src-tauri/target/release/bundle"

# 定位主安装包（dmg/deb/appimage/tar.gz）
INSTALLER_PATH=""
INSTALLER_NAME=""
case "$(uname -s)" in
    Darwin)
        # macOS: .app.tar.gz (updater 用) 和 .dmg (手动安装用)
        if ls "$BUNDLE_DIR/macos/"*.app.tar.gz >/dev/null 2>&1; then
            INSTALLER_PATH=$(ls "$BUNDLE_DIR/macos/"*.app.tar.gz | head -1)
        elif ls "$BUNDLE_DIR/dmg/"*.dmg >/dev/null 2>&1; then
            INSTALLER_PATH=$(ls "$BUNDLE_DIR/dmg/"*.dmg | head -1)
        fi
        ;;
    Linux)
        if ls "$BUNDLE_DIR/appimage/"*.AppImage.tar.gz >/dev/null 2>&1; then
            INSTALLER_PATH=$(ls "$BUNDLE_DIR/appimage/"*.AppImage.tar.gz | head -1)
        elif ls "$BUNDLE_DIR/deb/"*.deb >/dev/null 2>&1; then
            INSTALLER_PATH=$(ls "$BUNDLE_DIR/deb/"*.deb | head -1)
        fi
        ;;
esac

if [ -z "$INSTALLER_PATH" ]; then
    echo -e "\033[33m  未找到安装包，跳过 latest.json 生成。\033[0m"
    echo -e "\033[36m产物目录: $BUNDLE_DIR\033[0m"
    ls -lR "$BUNDLE_DIR" 2>/dev/null || true
    exit 0
fi

INSTALLER_NAME=$(basename "$INSTALLER_PATH")
INSTALLER_SIG="${INSTALLER_PATH}.sig"

# 读取版本号
APP_VERSION=$(python3 -c "import json; print(json.load(open('$TAURI_DIR/src-tauri/tauri.conf.json'))['version'])")

REPO_OWNER="jameszeng222"
REPO_NAME="ht-logistic-workspace-v2"
INSTALLER_URL="https://github.com/$REPO_OWNER/$REPO_NAME/releases/latest/download/$INSTALLER_NAME"

# 读取签名
SIGNATURE=""
if [ -f "$INSTALLER_SIG" ]; then
    SIGNATURE=$(cat "$INSTALLER_SIG" | tr -d '\n\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
else
    echo -e "\033[33m  WARNING: .sig 文件不存在: $INSTALLER_SIG\033[0m"
    echo -e "\033[33m  自动更新不可用。是否设置了 TAURI_SIGNING_PRIVATE_KEY？\033[0m"
fi

# 根据当前平台选择 target key
case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)   TARGET_KEY="darwin-aarch64";;
    Darwin-x86_64)  TARGET_KEY="darwin-x86_64";;
    Linux-aarch64)  TARGET_KEY="linux-aarch64";;
    Linux-x86_64)   TARGET_KEY="linux-x86_64";;
    *)              TARGET_KEY="unknown";;
esac

PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
RELEASE_NOTES="HT Logistic Agent v$APP_VERSION. See GitHub Release for details."

# 生成 latest.json（python3 保证 JSON 转义正确）
python3 -c "
import json, sys
data = {
    'version': '$APP_VERSION',
    'notes': '''$RELEASE_NOTES''',
    'pub_date': '$PUB_DATE',
    'platforms': {
        '$TARGET_KEY': {
            'signature': '''$SIGNATURE''',
            'url': '$INSTALLER_URL'
        }
    }
}
print(json.dumps(data, indent=2, ensure_ascii=False))
" > "$BUNDLE_DIR/latest.json"

LATEST_JSON="$BUNDLE_DIR/latest.json"

echo ""
echo -e "\033[36m================================================\033[0m"
echo -e "\033[36m  构建产物已就绪\033[0m"
echo -e "\033[36m================================================\033[0m"
echo ""
echo -e "\033[33m上传这 3 个文件到新的 GitHub Release：\033[0m"
echo ""
for f in "$INSTALLER_PATH" "$INSTALLER_SIG" "$LATEST_JSON"; do
    if [ -f "$f" ]; then
        SIZE=$(ls -lh "$f" | awk '{print $5}')
        echo "  $f  ($SIZE)"
    else
        echo -e "  \033[31m$f  (缺失!)\033[0m"
    fi
done
echo ""
echo -e "\033[36m发布步骤：\033[0m"
echo "  1. Tag: v$APP_VERSION  (必须与 tauri.conf.json 里的 version 一致)"
echo "  2. Title: HT Logistic Agent v$APP_VERSION"
echo "  3. 附加以上 3 个文件"
echo "  4. Publish release"
echo ""
echo -e "\033[36m客户端 endpoint（已在 tauri.conf.json 配好）：\033[0m"
echo "  https://github.com/$REPO_OWNER/$REPO_NAME/releases/latest/download/latest.json"
echo ""
echo -e "\033[32m用户双击安装即可，无需装 Node.js / Python / Rust。\033[0m"
