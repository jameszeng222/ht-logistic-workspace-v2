import pdfplumber
import pandas as pd
import re
import os

# 尝试导入OCR相关库（优先使用Tesseract）
try:
    import pytesseract
    from PIL import Image
    OCR_AVAILABLE = True
    OCR_TYPE = 'tesseract'
    # 设置Tesseract路径（如果不在PATH中）
    try:
        pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
    except:
        pass
except ImportError:
    try:
        import easyocr
        OCR_AVAILABLE = True
        OCR_TYPE = 'easyocr'
    except ImportError:
        OCR_AVAILABLE = False
        OCR_TYPE = None
        print("警告：未安装OCR工具（pytesseract或easyocr），图片格式的PDF将无法识别")

def extract_standard_customs(pdf_path, wanyitong_no):
    """提取标准海关出口货物报关单数据"""
    result_data = []
    
    shipper_name = ""
    declare_no = ""
    declare_date_str = ""
    trade_term = ""
    customs_name = ""
    packages_count = 0
    
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page_num, page in enumerate(pdf.pages):
                text = page.extract_text()
                if not text:
                    continue
                
                lines = text.split('\n')
                
                # 只在第一页提取表头信息
                if page_num == 0:
                    for i, line in enumerate(lines):
                        line = line.strip()
                        
                        # 提取境内发货人信息
                        if "境内发货人" in line:
                            if i + 1 < len(lines):
                                next_line = lines[i + 1].strip()
                                parts = next_line.split()
                                if len(parts) >= 2:
                                    shipper_name = parts[0]
                                    customs_name = parts[1]
                                    # 查找日期（报关单中有两个日期：出口日期和申报日期，取第二个即申报日期）
                                    # 如果只有一个日期，则取这个日期
                                    date_count = 0
                                    first_date = ""
                                    for part in parts:
                                        if len(part) == 8 and part.startswith('202'):
                                            date_count += 1
                                            if date_count == 1:
                                                first_date = part
                                            # 第二个日期是申报日期
                                            if date_count == 2:
                                                declare_date_str = part
                                                break
                                    # 如果只有一个日期，取第一个日期
                                    if not declare_date_str and first_date:
                                        declare_date_str = first_date
                        
                        # 提取海关编号
                        match = re.search(r"海关编号[：:]\s*(\d{18})", line)
                        if match:
                            declare_no = match.group(1)
                        if not declare_no:
                            match = re.search(r"预录入编号[：:]\s*(\d{18})", line)
                            if match:
                                declare_no = match.group(1)
                        
                        # 提取成交方式
                        if "成交方式" in line:
                            if i + 1 < len(lines):
                                next_line = lines[i + 1].strip()
                                next_parts = next_line.split()
                                for part in next_parts:
                                    if part.isalpha() and len(part) <= 4 and part.isupper():
                                        trade_term = part
                                        break
                        
                        # 提取件数（在"件数"标签所在行的下一行）
                        if packages_count == 0 and "件数" in line:
                            if i + 1 < len(lines):
                                next_line = lines[i + 1].strip()
                                next_parts = next_line.split()
                                for part in next_parts:
                                    if part.isdigit():
                                        packages_count = int(part)
                                        break
                
                # 提取商品数据
                for i, line in enumerate(lines):
                    line = line.strip()
                    if not line:
                        continue
                    
                    # 检查是否是商品行（以数字开头，且有10位商品编号）
                    if line[0].isdigit():
                        parts = line.split()
                        if len(parts) >= 3:
                            # 尝试从parts[1]中提取10位商品编号（可能和商品名称连在一起）
                            product_code = ""
                            product_name = ""
                            second_part = parts[1]
                            
                            # 查找10位数字的商品编号
                            code_match = re.search(r'(\d{10})', second_part)
                            if code_match:
                                product_code = code_match.group(1)
                                # 提取商品名称（编号后面的部分）
                                product_name = second_part[10:].strip()
                            else:
                                # 如果没有找到10位编号，尝试其他方式
                                continue
                            
                            # 查找千克数量
                            kg_value = 0
                            kg_index = -1
                            for j, part in enumerate(parts):
                                if "千克" in part:
                                    kg_index = j
                                    kg_value = float(part.replace("千克", ""))
                                    break
                            
                            if kg_index == -1:
                                continue
                            
                            # 如果商品名称为空，从后续部分补充
                            if not product_name:
                                product_name = " ".join(parts[2:kg_index])
                            else:
                                # 如果商品名称来自parts[1]，补充后续部分
                                product_name += " " + " ".join(parts[2:kg_index])
                            
                            # 单价
                            unit_price = 0
                            if kg_index + 1 < len(parts):
                                try:
                                    unit_price = float(parts[kg_index + 1])
                                except:
                                    pass
                            
                            # 从后续行查找第二计量单位、数量和总价
                            quantity_pcs = 0
                            second_unit = ""
                            total_price = 0
                            
                            for j in range(i + 1, min(i + 6, len(lines))):
                                next_line = lines[j].strip()
                                if not next_line:
                                    continue
                                
                                next_parts = next_line.split()
                                
                                # 查找第二计量单位（个、条）
                                if not second_unit:
                                    for part in next_parts:
                                        if "个" in part:
                                            pcs_match = re.search(r'([\d.]+)个', part)
                                            if pcs_match:
                                                quantity_pcs = int(float(pcs_match.group(1)))
                                                second_unit = "个"
                                                break
                                        elif "条" in part:
                                            pcs_match = re.search(r'([\d.]+)条', part)
                                            if pcs_match:
                                                quantity_pcs = int(float(pcs_match.group(1)))
                                                second_unit = "条"
                                                break
                                
                                # 查找总价
                                if total_price == 0 and unit_price > 0:
                                    for part in next_parts:
                                        try:
                                            num = float(part)
                                            if num >= unit_price and num < unit_price * 10000:
                                                total_price = num
                                                break
                                        except:
                                            continue
                            
                            # 如果没找到个数，用千克数（保留小数）
                            if quantity_pcs == 0:
                                quantity_pcs = kg_value
                            
                            # 如果第二计量单位是空的，设为千克
                            if not second_unit:
                                second_unit = "千克"
                            
                            # 计算发货数量
                            shipping_quantity = quantity_pcs
                            if second_unit == "千克" and packages_count > 0:
                                shipping_quantity = packages_count * 30
                            
                            # 清理商品名称
                            product_name = re.sub(r'\|.*', '', product_name).strip()
                            
                            # 格式化日期
                            fmt_date = ""
                            if declare_date_str:
                                fmt_date = f"{declare_date_str[:4]}-{declare_date_str[4:6]}-{declare_date_str[6:8]}"
                            
                            # 添加到结果
                            result_data.append({
                                "万邑通单号": wanyitong_no,
                                "报关主体公司名": shipper_name,
                                "销售团队": "乐米-闫超",
                                "成交方式": trade_term,
                                "出境关别": customs_name,
                                "报关单号": declare_no,
                                "申报日期": fmt_date,
                                "报关月份": fmt_date[:7] if fmt_date else "",
                                "报关\n商品编号": product_code,
                                "报关\n商品名称": product_name,
                                "报关\n数量（千克）": kg_value,
                                "报关\n数量": quantity_pcs,
                                "发货数量": shipping_quantity,
                                "报关单价": unit_price,
                                "第二计量单位（报关单位）": second_unit,
                                "报关应付汇\n": total_price
                            })
    
    except Exception as e:
        print(f"解析失败 {os.path.basename(pdf_path)}: {e}")
    
    return result_data

def extract_delegation_agreement(pdf_path, wanyitong_no):
    """提取委托报关协议格式的数据"""
    result_data = []
    
    shipper_name = ""
    declare_no = ""
    product_code = ""
    product_name = ""
    declare_date_str = ""
    trade_term = ""
    
    try:
        with pdfplumber.open(pdf_path) as pdf:
            # 只处理第一页，因为第二页是通用条款
            if pdf.pages:
                text = pdf.pages[0].extract_text()
                if text:
                    lines = text.split('\n')
                    
                    for line in lines:
                        line = line.strip()
                        
                        # 提取委托方（报关主体公司名）
                        if "委托方" in line and not shipper_name:
                            # 格式：委托方 鄄城凯航工艺品有限公司 被委托方 ...
                            parts = line.split()
                            for i, part in enumerate(parts):
                                if part == "委托方":
                                    if i + 1 < len(parts) and parts[i+1] != "被委托方":
                                        shipper_name = parts[i+1]
                                        break
                        
                        # 提取报关单编号
                        if "报关单编号" in line:
                            match = re.search(r'报关单编号\s*No\.?\s*(\d+)', line)
                            if match:
                                declare_no = match.group(1)
                        
                        # 提取HS编码（商品编号）
                        if "HS编码" in line:
                            match = re.search(r'HS编码\s*(\d{10})', line)
                            if match:
                                product_code = match.group(1)
                        
                        # 提取货物名称
                        if "主要货物名称" in line:
                            # 格式：主要货物名称人发制假发 *报关单编号...
                            parts = line.split('*')
                            if parts:
                                product_name = parts[0].replace("主要货物名称", "").strip()
                        
                        # 提取日期
                        if "收到单证日期" in line:
                            match = re.search(r'收到单证日期(\d{4})年(\d{2})月(\d{2})日', line)
                            if match:
                                declare_date_str = f"{match.group(1)}{match.group(2)}{match.group(3)}"
                        
                        # 提取贸易方式
                        if "贸易方式" in line:
                            # 格式：贸易方式 进料对口 收到单证情况...
                            match = re.search(r'贸易方式\s+([^\s]+)', line)
                            if match:
                                trade_term = match.group(1)
            
            # 格式化日期
            fmt_date = ""
            if declare_date_str:
                fmt_date = f"{declare_date_str[:4]}-{declare_date_str[4:6]}-{declare_date_str[6:8]}"
            
            # 如果提取到了关键信息，添加一行数据
            if product_code or product_name or declare_no:
                result_data.append({
                    "万邑通单号": wanyitong_no,
                    "报关主体公司名": shipper_name,
                    "销售团队": "乐米-闫超",
                    "成交方式": trade_term,
                    "出境关别": "",
                    "报关单号": declare_no,
                    "申报日期": fmt_date,
                    "报关月份": fmt_date[:7] if fmt_date else "",
                    "报关\n商品编号": product_code,
                    "报关\n商品名称": product_name,
                    "报关\n数量（千克）": 0,
                    "报关\n数量": 0,
                    "发货数量": 0,
                    "报关单价": 0,
                    "第二计量单位（报关单位）": "",
                    "报关应付汇\n": 0
                })
    
    except Exception as e:
        print(f"解析委托报关协议失败 {os.path.basename(pdf_path)}: {e}")
    
    return result_data

def extract_text_from_image_page(page):
    """尝试从图片格式的PDF页面中提取文本（使用OCR）"""
    if not OCR_AVAILABLE:
        return ""
    
    try:
        # 将页面转换为图像（使用更高的分辨率）
        image = page.to_image(resolution=200)
        img_pil = image.original
        
        # 图像预处理：转换为RGB并增强对比度
        if img_pil.mode != 'RGB':
            img_pil = img_pil.convert('RGB')
        
        # 增强对比度以提高OCR准确度
        try:
            from PIL import ImageEnhance
            enhancer = ImageEnhance.Contrast(img_pil)
            img_pil = enhancer.enhance(2.0)
        except:
            pass
        
        # 将PIL Image转换为numpy数组
        import numpy as np
        img_array = np.array(img_pil)
        
        # 根据OCR类型选择识别方式
        if OCR_TYPE == 'easyocr':
            # 使用EasyOCR识别
            try:
                reader = easyocr.Reader(['ch_sim', 'en'], gpu=False, verbose=False)
                result = reader.readtext(img_array)
                
                if not result:
                    return ""
                
                # 合并识别结果，保留位置信息以便排序
                result.sort(key=lambda x: (x[0][0][1], x[0][0][0]))  # 按y坐标排序，再按x坐标
                
                # 按行合并文本
                text_lines = []
                current_y = -1
                line_text = ""
                
                for item in result:
                    y = item[0][0][1]
                    confidence = item[2] if len(item) > 2 else 1.0
                    
                    # 过滤低置信度的结果
                    if confidence < 0.3:
                        continue
                    
                    text_content = item[1]
                    
                    if current_y == -1:
                        current_y = y
                        line_text = text_content
                    elif abs(y - current_y) < 25:  # 同一行（放宽条件以处理表格）
                        line_text += " " + text_content
                    else:
                        text_lines.append(line_text)
                        current_y = y
                        line_text = text_content
                
                if line_text:
                    text_lines.append(line_text)
                
                text = '\n'.join(text_lines)
                return text
                
            except Exception as e:
                print(f"OCR识别失败: {e}")
                return ""
        elif OCR_TYPE == 'tesseract':
            # 使用pytesseract识别
            try:
                text = pytesseract.image_to_string(img_pil, lang='chi_sim')
                return text
            except Exception as e:
                print(f"Tesseract识别失败: {e}")
                return ""
        else:
            return ""
    except Exception as e:
        print(f"OCR处理失败: {e}")
        return ""

def is_image_pdf(page):
    """判断页面是否是图片格式（包含图像但文本很少或乱码）"""
    text = page.extract_text()
    
    # 如果没有提取到文本，肯定是图片格式
    if not text:
        return True
    
    # 检查是否是乱码（包含大量cid:字符）
    cid_count = text.count('cid:')
    if cid_count > len(text) * 0.1:  # 如果cid:占文本的10%以上，认为是乱码
        return True
    
    # 如果页面有图像，需要进一步判断
    has_images = len(page.images) > 0
    
    if has_images:
        # 计算中文字符数
        chinese_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
        
        # 如果有图像但中文字符少于50个，认为是图片格式
        if chinese_chars < 50:
            return True
        
        # 如果文本长度很短，也可能是图片格式
        if len(text) < 100:
            return True
    
    # 检查文本是否看起来像有效报关单内容
    key_texts = ["海关出口货物报关单", "境内发货人", "海关编号", "成交方式", "商品名称"]
    found_count = sum(1 for key in key_texts if key in text)
    
    # 如果没有找到任何报关单关键词，但页面有图像，可能是图片格式
    if has_images and found_count == 0:
        return True
    
    return False

def extract_size_from_name(product_name):
    """从商品名称中提取英寸信息"""
    # 匹配各种英寸格式：
    # 12英寸, 16-18英寸, 22-24英寸, 16"-24", 12-18英寸, 16-30英寸
    patterns = [
        r'(\d{1,2}[-–—]\d{1,2}英寸)',  # 16-18英寸, 22-24英寸
        r'(\d{1,2}英寸)',               # 12英寸
        r'(\d{1,2}"[–—-]\d{1,2}")',    # 16"-24"
        r'(\d{1,2}[-–—]\d{1,2}"?)',    # 16-30, 16-30"
    ]
    
    for pattern in patterns:
        match = re.search(pattern, product_name)
        if match:
            result = match.group(1)
            # 统一格式，添加英寸单位
            if '"' in result:
                result = result.replace('"', '') + '英寸'
            elif '英寸' not in result:
                result = result + '英寸'
            return result
    
    return ""

def extract_single_pdf(pdf_path):
    """从单个PDF文件中提取报关单数据（只提取标准报关单页面）"""
    file_name = os.path.basename(pdf_path)
    print(f"处理文件: {file_name}")
    
    # 从文件名中提取万邑通单号（WI或FBA开头）
    wanyitong_no = ""
    match = re.search(r'(WI\d+|FBA[\dA-Z]+)', file_name)
    if match:
        wanyitong_no = match.group(1)
    
    all_result_data = []
    
    try:
        with pdfplumber.open(pdf_path) as pdf:
            # 检查所有页面，识别报关单页面
            customs_pages = []
            
            for page_num, page in enumerate(pdf.pages):
                # 首先尝试普通文本提取
                text = page.extract_text()
                
                # 检查是否是乱码（包含大量cid:字符）
                is_garbage = False
                if text:
                    cid_count = text.count('cid:')
                    if cid_count > len(text) * 0.1:
                        is_garbage = True
                        print(f"  第{page_num+1}页检测到乱码，尝试OCR...")
                
                # 如果普通提取失败、内容很少、或者是乱码，尝试OCR
                if not text or len(text) < 100 or is_garbage:
                    if is_image_pdf(page):
                        text = extract_text_from_image_page(page)
                
                # 检查报关单关键词（支持OCR可能的识别错误）
                if text:
                    # 多种可能的关键词匹配（处理OCR识别错误）
                    customs_keywords = [
                        "中华人民共和国海关出口货物报关单",
                        "中华人民其和国海关出口货物报关单",  # OCR可能识别错误
                        "海关出口货物报关单",
                        "中华人民共和国海关"
                    ]
                    if any(keyword in text for keyword in customs_keywords):
                        customs_pages.append(page_num)
            
            # 如果找到报关单页面，提取报关单数据
            if customs_pages:
                print(f"  找到 {len(customs_pages)} 个报关单页面")
                # 将连续的报关单页面分组
                customs_groups = []
                current_group = [customs_pages[0]]
                
                for i in range(1, len(customs_pages)):
                    if customs_pages[i] == customs_pages[i-1] + 1:
                        current_group.append(customs_pages[i])
                    else:
                        customs_groups.append(current_group)
                        current_group = [customs_pages[i]]
                
                if current_group:
                    customs_groups.append(current_group)
                
                # 对每组报关单页面进行提取
                for group in customs_groups:
                    group_data = extract_customs_from_pages(pdf, group, wanyitong_no)
                    all_result_data.extend(group_data)
    
    except Exception as e:
        print(f"打开PDF失败 {file_name}: {e}")
        return []
    
    return all_result_data

def get_text_from_page(page):
    """从页面中提取文本，支持普通文本和OCR"""
    # 首先尝试普通文本提取
    text = page.extract_text()
    
    # 检查是否是乱码文本
    if text:
        cid_count = text.count('cid:')
        if cid_count > len(text) * 0.1:
            print(f"  检测到乱码PDF文本，尝试OCR...")
            text = ""
    
    # 如果普通提取失败、内容很少、或者中文字符很少（可能是图片格式），尝试OCR
    if not text or len(text) < 100 or is_image_pdf(page):
        if len(page.images) > 0:  # 只有在有图像时才尝试OCR
            text = extract_text_from_image_page(page)
    
    # 清理文本中的乱码字符
    if text:
        # 移除cid:xxx格式的乱码
        import re
        text = re.sub(r'cid:\d+', '', text)
        # 先按换行符分割，避免把换行符替换掉
        lines = text.split('\n')
        cleaned_lines = []
        for line in lines:
            # 移除行内多余的空白字符（保留单个空格）
            line = re.sub(r'[ \t]+', ' ', line).strip()
            if not line:
                continue
            # 如果一行中非ASCII字符超过50%，保留；否则过滤
            ascii_count = sum(1 for c in line if ord(c) < 128)
            special_count = len(line) - ascii_count
            if len(line) > 0 and (special_count < len(line) * 0.5 or any('\u4e00' <= c <= '\u9fff' for c in line)):
                cleaned_lines.append(line)
        text = '\n'.join(cleaned_lines)
    
    return text

def extract_customs_from_pages(pdf, page_nums, wanyitong_no):
    """从指定的页面组中提取报关单数据"""
    result_data = []
    
    shipper_name = ""
    declare_no = ""
    declare_date_str = ""
    trade_term = ""
    customs_name = ""
    packages_count = 0
    
    try:
        # 提取第一页的表头信息（尝试从所有报关单页面提取）
        for page_num in page_nums:
            text = get_text_from_page(pdf.pages[page_num])
            if not text:
                continue
            
            lines = text.split('\n')
            
            for i, line in enumerate(lines):
                line = line.strip()
                
                # 提取境内发货人信息（多种格式）
                if not shipper_name and ("境内发货人" in line or "发货单位" in line):
                    # 尝试从当前行提取
                    match = re.search(r'(境内发货人|发货单位)[：:]\s*([^\s]+)', line)
                    if match:
                        shipper_name = match.group(2)
                    elif i + 1 < len(lines):
                        next_line = lines[i + 1].strip()
                        parts = next_line.split()
                        if len(parts) >= 1:
                            shipper_name = parts[0]
                
                # 提取出境关别
                if not customs_name and ("出境关别" in line or "出口口岸" in line):
                    match = re.search(r'(出境关别|出口口岸)[：:]\s*([^\s]+)', line)
                    if match:
                        customs_name = match.group(2)
                    elif i + 1 < len(lines):
                        next_line = lines[i + 1].strip()
                        parts = next_line.split()
                        if len(parts) >= 1:
                            customs_name = parts[0]
                
                # 提取海关编号（支持更多格式）
                if not declare_no:
                    match = re.search(r"海关编号[：:]\s*(\d{18})", line)
                    if match:
                        declare_no = match.group(1)
                if not declare_no:
                    match = re.search(r"预录入编号[：:]\s*(\d{18})", line)
                    if match:
                        declare_no = match.group(1)
                if not declare_no:
                    match = re.search(r"报关单号[：:]\s*(\d{18})", line)
                    if match:
                        declare_no = match.group(1)
                
                # 提取申报日期
                if not declare_date_str:
                    # 优先从"申报日期"标签后提取
                    match = re.search(r"申报日期[：:]\s*(\d{4}-\d{2}-\d{2})", line)
                    if match:
                        declare_date_str = match.group(1).replace('-', '')
                    # 其次从包含"境内发货人"的行后提取（报关单格式）
                    elif "境内发货人" in line and i + 1 < len(lines):
                        next_line = lines[i + 1].strip()
                        parts = next_line.split()
                        date_count = 0
                        first_date = ""
                        for part in parts:
                            if len(part) == 8 and part.startswith('202'):
                                date_count += 1
                                if date_count == 1:
                                    first_date = part
                                # 第二个日期是申报日期
                                if date_count == 2:
                                    declare_date_str = part
                                    break
                        # 如果只有一个日期，取第一个日期
                        if not declare_date_str and first_date:
                            declare_date_str = first_date
                
                # 提取成交方式
                if not trade_term and "成交方式" in line:
                    match = re.search(r'成交方式[：:]\s*([A-Za-z]{1,4})', line)
                    if match:
                        trade_term = match.group(1).upper()
                    elif i + 1 < len(lines):
                        next_line = lines[i + 1].strip()
                        next_parts = next_line.split()
                        for part in next_parts:
                            if part.isalpha() and len(part) <= 4:
                                trade_term = part.upper()
                                break
                
                # 提取件数
                if packages_count == 0 and "件数" in line:
                    if i + 1 < len(lines):
                        next_line = lines[i + 1].strip()
                        next_parts = next_line.split()
                        for part in next_parts:
                            if part.isdigit():
                                packages_count = int(part)
                                break
                    if packages_count == 0:
                        match = re.search(r'件数\s*(\d+)', line)
                        if match:
                            packages_count = int(match.group(1))
        
        # 从所有页面中提取商品数据
        for page_num in page_nums:
            text = get_text_from_page(pdf.pages[page_num])
            if not text:
                continue
            
            lines = text.split('\n')
            
            # 合并多行（处理OCR可能的断行问题）
            merged_lines = []
            for i, line in enumerate(lines):
                line = line.strip()
                if not line:
                    continue
                # 如果当前行以数字开头且上一行没有以数字开头，可能是同一行的延续
                if merged_lines and line[0].isdigit():
                    # 检查是否是新的商品行
                    if merged_lines[-1] and not merged_lines[-1][-1].isdigit():
                        merged_lines.append(line)
                    else:
                        # 可能是延续
                        merged_lines[-1] += " " + line
                else:
                    merged_lines.append(line)
            
            lines = merged_lines
            
            # 提取商品数据
            for i, line in enumerate(lines):
                line = line.strip()
                if not line:
                    continue
                
                # 策略1：检查是否是商品行（以数字开头，且有10位商品编号）
                if line[0].isdigit():
                    parts = line.split()
                    if len(parts) >= 2:
                        # 初始化变量
                        product_code = ""
                        product_name = ""
                        second_unit = ""
                        quantity_pcs = 0
                        spec = ""
                        
                        # 首先检查parts[0]是否是纯数字（可能是项号）
                        if parts[0].isdigit() and len(parts[0]) < 5:
                            # parts[0]可能是项号，检查parts[1]是否包含10位商品编号
                            code_match = re.search(r'(\d{10})', parts[1])
                            if code_match:
                                product_code = code_match.group(1)
                                # 检查parts[1]是否包含商品名称（长度超过10位）
                                if len(parts[1]) > 10:
                                    # 商品名称和编号连在一起，从parts[1]中提取
                                    raw_name = parts[1][10:].strip()
                                elif len(parts) > 2:
                                    # 商品名称在parts[2]中
                                    raw_name = parts[2].strip()
                                else:
                                    raw_name = ""
                                
                                # 从商品名称中提取规格信息
                                spec_from_name = ""
                                # 匹配英寸规格（如 6", 8", 10"-30"等）
                                inch_match = re.search(r'(\d+["\'’])(-\d+["\'’])?', raw_name)
                                if inch_match:
                                    spec_from_name = inch_match.group(0).replace('"', '英寸').replace("'", "英寸").replace('’', '英寸')
                                    # 清理商品名称，移除规格部分
                                    product_name = re.sub(r'\d+["\'’](-\d+["\'’])?', '', raw_name).strip()
                                else:
                                    product_name = raw_name
                                
                                # 商品名称可能还需要从parts[3]开始补充，但要在遇到数量/单价前停止
                                for part in parts[3:]:
                                    # 如果遇到千克相关或小数（单价），停止
                                    if any(keyword in part or keyword.upper() in part.upper() for keyword in ["千克", "KG", "公斤", "二死"]):
                                        break
                                    try:
                                        float(part)
                                        if '.' in part:
                                            break
                                    except:
                                        pass
                                    product_name += " " + part
                                product_name = product_name.strip()
                                
                                # 如果从名称中提取了规格，保存起来
                                if spec_from_name and not spec:
                                    spec = spec_from_name
                            else:
                                # 尝试从其他位置查找10位编号
                                for part in parts:
                                    code_match = re.search(r'(\d{10})', part)
                                    if code_match:
                                        product_code = code_match.group(1)
                                        idx = parts.index(part)
                                        product_name = " ".join(parts[idx+1:])
                                        # 截断商品名称
                                        product_name_parts = []
                                        for p in product_name.split():
                                            if any(keyword in p or keyword.upper() in p.upper() for keyword in ["千克", "KG", "公斤", "二死"]):
                                                break
                                            try:
                                                float(p)
                                                if '.' in p:
                                                    break
                                            except:
                                                pass
                                            product_name_parts.append(p)
                                        product_name = " ".join(product_name_parts)
                                        break
                        else:
                            # 尝试从parts[0]中提取10位数字（可能和商品名称连在一起）
                            code_match = re.search(r'(\d{10})', parts[0])
                            if code_match:
                                product_code = code_match.group(1)
                                # 提取商品名称（编号后面的部分）
                                product_name = parts[0][10:].strip()
                                # 继续从parts[1]及以后提取商品名称，但需要截断
                                for part in parts[1:]:
                                    if any(keyword in part or keyword.upper() in part.upper() for keyword in ["千克", "KG", "公斤", "二死"]):
                                        break
                                    try:
                                        float(part)
                                        if '.' in part:
                                            break
                                    except:
                                        pass
                                    product_name += " " + part
                                product_name = product_name.strip()
                            else:
                                # 尝试从其他位置查找10位编号
                                for part in parts:
                                    code_match = re.search(r'(\d{10})', part)
                                    if code_match:
                                        product_code = code_match.group(1)
                                        idx = parts.index(part)
                                        product_name_parts = []
                                        for part in parts[idx+1:]:
                                            if any(keyword in part or keyword.upper() in part.upper() for keyword in ["千克", "KG", "公斤", "二死"]):
                                                break
                                            try:
                                                float(part)
                                                if '.' in part:
                                                    break
                                            except:
                                                pass
                                            product_name_parts.append(part)
                                        product_name = " ".join(product_name_parts)
                                        break
                        
                        if not product_code:
                            # 尝试查找8-12位数字作为商品编号
                            for part in parts:
                                code_match = re.search(r'(\d{8,12})', part)
                                if code_match:
                                    product_code = code_match.group(1)
                                    idx = parts.index(part)
                                    product_name_parts = []
                                    for part in parts[idx+1:]:
                                        if part.isdigit() and len(part) < 5:
                                            break
                                        try:
                                            float(part)
                                            if '.' in part:
                                                break
                                        except:
                                            pass
                                        if any(keyword in part or keyword.upper() in part.upper() for keyword in ["千克", "KG", "公斤", "二死"]):
                                            break
                                        if "照章" in part or "许虽" in part or "诈喇" in part or "0000" in part:
                                            break
                                        if ')' in part and any(c.isdigit() for c in part):
                                            break
                                        product_name_parts.append(part)
                                    product_name = " ".join(product_name_parts)
                                    break
                        
                        if not product_code:
                            continue
                        
                        # 查找千克数量（处理OCR识别错误，优先找"千克"而不是"二死"）
                        kg_value = 0
                        kg_index = -1
                        
                        # 支持OCR可能识别错误的关键词
                        kg_keywords_primary = ["千克", "KG", "公斤"]  # 优先级高
                        kg_keywords_secondary = ["二死", "干克", "仟克", "克"]  # 优先级低
                        
                        # 首先尝试从当前行查找
                        for j, part in enumerate(parts):
                            # 检查是否包含千克相关关键词
                            part_upper = part.upper()
                            if any(keyword in part or keyword.upper() in part_upper for keyword in kg_keywords_primary + kg_keywords_secondary):
                                try:
                                    # 尝试提取数值
                                    num_str = re.sub(r'[^\d.]', '', part)
                                    if num_str:
                                        kg_value = float(num_str)
                                        kg_index = j
                                        break
                                except:
                                    pass
                        
                        # 如果当前行没找到，再检查后续5行，找优先级高的关键词
                        if kg_value == 0:
                            for check_offset in range(1, 6):
                                if i + check_offset < len(lines):
                                    next_line = lines[i + check_offset].strip()
                                    if next_line:
                                        next_parts = next_line.split()
                                        for j, part in enumerate(next_parts):
                                            part_upper = part.upper()
                                            if any(keyword in part or keyword.upper() in part_upper for keyword in kg_keywords_primary):
                                                try:
                                                    num_str = re.sub(r'[^\d.]', '', part)
                                                    if num_str:
                                                        kg_value = float(num_str)
                                                        # 检查前一个部分是否也是数字（如"104. 8千克"）
                                                        if j > 0:
                                                            prev_part = next_parts[j - 1]
                                                            try:
                                                                prev_num_str = re.sub(r'[^\d.]', '', prev_part)
                                                                prev_num = float(prev_num_str)
                                                                # 如果前一个数字以点结尾，直接拼接
                                                                if prev_part.endswith('.'):
                                                                    kg_value = float(f"{prev_num}{num_str}")
                                                                # 如果前一个数字有小数点，也尝试合并
                                                                elif '.' in prev_part:
                                                                    kg_value = float(f"{prev_num}{num_str}")
                                                            except:
                                                                pass
                                                        kg_index = len(parts)  # 标记为从下一行获取
                                                        break
                                                except:
                                                    pass
                                        if kg_value > 0:
                                            break
                        
                        # 如果没找到，再找优先级低的关键词
                        if kg_value == 0:
                            for check_offset in range(1, 6):
                                if i + check_offset < len(lines):
                                    next_line = lines[i + check_offset].strip()
                                    if next_line:
                                        next_parts = next_line.split()
                                        for j, part in enumerate(next_parts):
                                            part_upper = part.upper()
                                            if any(keyword in part or keyword.upper() in part_upper for keyword in kg_keywords_secondary):
                                                try:
                                                    num_str = re.sub(r'[^\d.]', '', part)
                                                    if num_str:
                                                        kg_value = float(num_str)
                                                        kg_index = len(parts)  # 标记为从下一行获取
                                                        break
                                                except:
                                                    pass
                                        if kg_value > 0:
                                            break
                        
                        # 如果没找到千克，尝试从其他位置查找重量
                        if kg_value == 0:
                            for j, part in enumerate(parts):
                                try:
                                    num = float(part)
                                    if num > 0 and num < 100000:  # 合理的重量范围
                                        kg_value = num
                                        kg_index = j
                                        break
                                except:
                                    pass
                        
                        if kg_index == -1:
                            kg_index = len(parts) - 1
                        
                        # 如果商品名称为空，从后续部分补充
                        if not product_name:
                            product_name = " ".join(parts[1:kg_index])
                        
                        # 单价（从千克后面查找）
                        unit_price = 0
                        
                        # 首先在当前行查找单价（通常在千克数量后面）
                        for j in range(len(parts)):
                            part = parts[j]
                            # 检查是否是千克相关
                            part_upper = part.upper()
                            if any(keyword in part or keyword.upper() in part_upper for keyword in ["千克", "KG", "公斤", "二死"]):
                                # 千克后面可能是单价
                                if j + 1 < len(parts):
                                    try:
                                        unit_price = float(parts[j + 1])
                                        break
                                    except:
                                        pass
                        
                        # 如果没找到，尝试从其他位置查找小数（单价通常是小数）
                        if unit_price == 0:
                            for j in range(len(parts)):
                                try:
                                    val = float(parts[j])
                                    # 单价通常是小于1000的小数
                                    if val > 0 and val < 1000 and '.' in parts[j]:
                                        unit_price = val
                                        break
                                except:
                                    pass
                        
                        # 总价（通常在包含"|"的下一行）
                        total_price = 0
                        for j in range(i + 1, min(i + 6, len(lines))):
                            next_line = lines[j].strip()
                            if not next_line:
                                continue
                            
                            next_parts = next_line.split()
                            
                            # 优先从包含"|"的行提取总价（这是规格行）
                            if '|' in next_line:
                                for k, part in enumerate(next_parts):
                                    try:
                                        val = float(part)
                                        # 总价应该大于等于单价，且不会太大
                                        if val >= unit_price and val < unit_price * 10000:
                                            total_price = val
                                            break
                                    except:
                                        pass
                                if total_price > 0:
                                    break
                            
                            # 如果没找到，从普通行提取
                            for k, part in enumerate(next_parts):
                                try:
                                    val = float(part)
                                    # 总价通常是较大的数值，但要在合理范围内
                                    if unit_price > 0:
                                        if val >= unit_price and val < unit_price * 10000:
                                            total_price = val
                                            break
                                    else:
                                        if val > 10 and val < 1000000:
                                            total_price = val
                                            break
                                except:
                                    pass
                            if total_price > 0:
                                break
                        
                        # 查找第二计量单位（个、条、件）- 可能在规格行的下一行
                        if not second_unit:
                            # 检查后续更多行
                            for check_offset in range(1, min(8, len(lines) - i)):
                                if i + check_offset < len(lines):
                                    check_line = lines[i + check_offset].strip()
                                    if check_line:
                                        check_parts = check_line.split()
                                        for part in check_parts:
                                            if "个" in part:
                                                pcs_match = re.search(r'([\d.]+)\s*个', part)
                                                if pcs_match:
                                                    quantity_pcs = int(float(pcs_match.group(1)))
                                                    second_unit = "个"
                                                    break
                                            elif "条" in part:
                                                pcs_match = re.search(r'([\d.]+)\s*条', part)
                                                if pcs_match:
                                                    quantity_pcs = int(float(pcs_match.group(1)))
                                                    second_unit = "条"
                                                    break
                                            elif "件" in part:
                                                pcs_match = re.search(r'([\d.]+)\s*件', part)
                                                if pcs_match:
                                                    quantity_pcs = int(float(pcs_match.group(1)))
                                                    second_unit = "件"
                                                    break
                                        if second_unit:
                                            break
                        
                        # 查找总价
                        if total_price == 0 and unit_price > 0:
                            for part in next_parts:
                                try:
                                    num = float(part)
                                    if num >= unit_price and num < unit_price * 100000:
                                        total_price = num
                                        break
                                except:
                                    continue
                        
                        # 如果没找到总价，尝试计算
                        if total_price == 0 and unit_price > 0 and kg_value > 0:
                            total_price = unit_price * kg_value
                        
                        # 如果没找到个数，用千克数（保留小数）
                        if quantity_pcs == 0:
                            quantity_pcs = kg_value
                        
                        # 如果第二计量单位是空的，设为千克
                        if not second_unit:
                            second_unit = "千克"
                        
                        # 计算发货数量
                        shipping_quantity = quantity_pcs
                        if second_unit == "千克" and packages_count > 0:
                            shipping_quantity = packages_count * 30
                        
                        # 清理商品名称
                        product_name = re.sub(r'\|.*', '', product_name).strip()
                        
                        # 如果还没有提取到规格，从下一行提取规格信息（格式如：|数字|人发|16英寸|||）
                        if not spec:
                            for j in range(i + 1, min(i + 6, len(lines))):
                                next_line = lines[j].strip()
                                if not next_line:
                                    continue
                                
                                # 检查是否包含规格信息（格式：|数字|人发|规格英寸|||）
                                if '|' in next_line and '英寸' in next_line:
                                    # 提取英寸规格
                                    inch_match = re.search(r'(\d+[-–]?\d+英寸)', next_line)
                                    if inch_match:
                                        spec = inch_match.group(1)
                                        break
                                    # 也尝试匹配单个数字+英寸
                                    inch_match = re.search(r'(\d+英寸)', next_line)
                                    if inch_match:
                                        spec = inch_match.group(1)
                                        break
                                elif '英寸' in next_line:
                                    # 也检查是否直接包含英寸信息
                                    inch_match = re.search(r'(\d+[-–]?\d+英寸)', next_line)
                                    if inch_match:
                                        spec = inch_match.group(1)
                                        break
                                    inch_match = re.search(r'(\d+英寸)', next_line)
                                    if inch_match:
                                        spec = inch_match.group(1)
                                        break
                        
                        # 提取英寸规格信息（优先使用从下一行提取的规格）
                        size_info = spec if spec else extract_size_from_name(product_name)
                        
                        # 格式化日期
                        fmt_date = ""
                        if declare_date_str:
                            if len(declare_date_str) == 8:
                                fmt_date = f"{declare_date_str[:4]}-{declare_date_str[4:6]}-{declare_date_str[6:8]}"
                            else:
                                fmt_date = declare_date_str
                        
                        # 添加到结果
                        result_data.append({
                            "万邑通单号": wanyitong_no,
                            "报关主体公司名": shipper_name,
                            "销售团队": "乐米-闫超",
                            "成交方式": trade_term,
                            "出境关别": customs_name,
                            "报关单号": declare_no,
                            "申报日期": fmt_date,
                            "报关月份": fmt_date[:7] if fmt_date else "",
                            "报关\n商品编号": product_code,
                            "报关\n商品名称": product_name,
                            "规格": size_info,
                            "报关\n数量（千克）": kg_value,
                            "报关\n数量": quantity_pcs,
                            "发货数量": shipping_quantity,
                            "报关单价": unit_price,
                            "第二计量单位（报关单位）": second_unit,
                            "报关应付汇\n": total_price
                        })

    except Exception as e:
        print(f"解析报关单页面失败: {e}")
    
    return result_data

def extract_delegation_agreement_from_page(pdf, page_num, wanyitong_no):
    """从指定页面中提取委托报关协议数据"""
    result_data = []
    
    shipper_name = ""
    declare_no = ""
    product_code = ""
    product_name = ""
    declare_date_str = ""
    trade_term = ""
    
    try:
        text = pdf.pages[page_num].extract_text()
        if text:
            lines = text.split('\n')
            
            for line in lines:
                line = line.strip()
                
                # 提取委托方（报关主体公司名）
                if "委托方" in line and not shipper_name:
                    # 格式：委托方 鄄城凯航工艺品有限公司 被委托方 ...
                    parts = line.split()
                    for i, part in enumerate(parts):
                        if part == "委托方":
                            if i + 1 < len(parts) and parts[i+1] != "被委托方":
                                shipper_name = parts[i+1]
                                break
                
                # 提取报关单编号
                if "报关单编号" in line:
                    match = re.search(r'报关单编号\s*No\.?\s*(\d+)', line)
                    if match:
                        declare_no = match.group(1)
                
                # 提取HS编码（商品编号）
                if "HS编码" in line:
                    match = re.search(r'HS编码\s*(\d{10})', line)
                    if match:
                        product_code = match.group(1)
                
                # 提取货物名称
                if "主要货物名称" in line:
                    # 格式：主要货物名称人发制假发 *报关单编号...
                    parts = line.split('*')
                    if parts:
                        product_name = parts[0].replace("主要货物名称", "").strip()
                
                # 提取日期
                if "收到单证日期" in line:
                    match = re.search(r'收到单证日期(\d{4})年(\d{2})月(\d{2})日', line)
                    if match:
                        declare_date_str = f"{match.group(1)}{match.group(2)}{match.group(3)}"
                
                # 提取贸易方式
                if "贸易方式" in line:
                    # 格式：贸易方式 进料对口 收到单证情况...
                    match = re.search(r'贸易方式\s+([^\s]+)', line)
                    if match:
                        trade_term = match.group(1)
        
        # 格式化日期
        fmt_date = ""
        if declare_date_str:
            fmt_date = f"{declare_date_str[:4]}-{declare_date_str[4:6]}-{declare_date_str[6:8]}"
        
        # 如果提取到了关键信息，添加一行数据
        if product_code or product_name or declare_no:
            result_data.append({
                "万邑通单号": wanyitong_no,
                "报关主体公司名": shipper_name,
                "销售团队": "乐米-闫超",
                "成交方式": trade_term,
                "出境关别": "",
                "报关单号": declare_no,
                "申报日期": fmt_date,
                "报关月份": fmt_date[:7] if fmt_date else "",
                "报关\n商品编号": product_code,
                "报关\n商品名称": product_name,
                "报关\n数量（千克）": 0,
                "报关\n数量": 0,
                "发货数量": 0,
                "报关单价": 0,
                "第二计量单位（报关单位）": "",
                "报关应付汇\n": 0
            })
    
    except Exception as e:
        print(f"解析委托报关协议页面失败: {e}")
    
    return result_data

def main():
    print("=== 开始提取报关单数据 ===")
    
    current_dir = os.path.dirname(os.path.abspath(__file__))
    pdf_files = [f for f in os.listdir(current_dir) if f.lower().endswith('.pdf')]
    
    if not pdf_files:
        print("未找到PDF文件")
        return
    
    all_data = []
    for pdf_file in pdf_files:
        pdf_path = os.path.join(current_dir, pdf_file)
        data = extract_single_pdf(pdf_path)
        all_data.extend(data)
    
    if all_data:
        df = pd.DataFrame(all_data)
        
        # 尝试保存到不同文件名，避免文件被占用
        import time
        output_path = os.path.join(current_dir, "报关单提取结果.xlsx")
        
        try:
            df.to_excel(output_path, index=False)
        except PermissionError:
            # 如果文件被占用，使用带时间戳的文件名
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            output_path = os.path.join(current_dir, f"报关单提取结果_{timestamp}.xlsx")
            df.to_excel(output_path, index=False)
        
        print(f"成功！共提取 {len(all_data)} 行数据")
        print(f"文件已保存至: {output_path}")
    else:
        print("未提取到任何数据")

if __name__ == "__main__":
    main()
