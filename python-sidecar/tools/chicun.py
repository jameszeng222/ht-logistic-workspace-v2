import re
import pandas as pd

# 直接读取Excel文件
df = pd.read_excel('商品尺寸清单.xlsx', sheet_name='Sheet1')

def extract_size(sku):
    # 检查sku是否为字符串类型，处理空值情况
    if pd.isna(sku) or not isinstance(sku, str):
        return None
    
    # 首先检查是否有括号内的多尺寸格式（如(16-18-20)或（16"+18"+20"））
    # 匹配括号内的内容
    bracket_match = re.search(r'[\(\（]([^)\）]+)[\)\）]', sku)
    if bracket_match:
        bracket_content = bracket_match.group(1)
        # 提取所有两位数字
        sizes = re.findall(r'\d{2}', bracket_content)
        # 如果找到至少3个数字，认为是多尺寸格式
        if len(sizes) >= 3:
            valid_sizes = sorted(set([s for s in sizes if 4 <= int(s) <= 36]))
            if valid_sizes:
                return '+'.join(valid_sizes)
    
    # 按'-'分割
    parts = sku.split('-')
    for part in parts:
        # 匹配两位数字开头，后面跟着1-2个大写字母（如10M, 16M, 12F, 26Q）
        match = re.match(r'^(\d{2})([A-Z]{1,2})$', part)
        if match:
            size_num = int(match.group(1))
            if 4 <= size_num <= 36:
                return str(size_num)
        # 匹配纯两位数字（如10, 12, 16）
        match2 = re.match(r'^(\d{2})$', part)
        if match2:
            size_num = int(match2.group(1))
            if 4 <= size_num <= 36:
                return str(size_num)
        # 匹配一位数字后面跟着一个字母（如6F）
        match4 = re.match(r'^(\d{1})([A-Z])$', part)
        if match4:
            size_num = int(match4.group(1))
            if 4 <= size_num <= 36:
                return str(size_num)
        # 匹配字母后面跟着两位数字（如ST20, KC16, TD22, BOHA20, XWW24）
        # 要求数字必须在末尾，字母部分至少2个字符，且数字≥10，避免匹配到MW05这样的产品型号
        match3 = re.match(r'^[A-Z]{2,}(\d{2})$', part)
        if match3:
            size_num = int(match3.group(1))
            if 10 <= size_num <= 36:
                return str(size_num)
    return None

# 对所有行重新提取尺寸
df['尺寸'] = df['商品名称'].apply(extract_size)

# 保存结果
df.to_excel('商品尺寸清单_已提取_final.xlsx', index=False)
print('处理完成！')
print(f'总数据行数: {len(df)}')
print(f'已提取尺寸: {df["尺寸"].count()}')
print(f'未提取尺寸: {df["尺寸"].isna().sum()}')
print(df.head(50))