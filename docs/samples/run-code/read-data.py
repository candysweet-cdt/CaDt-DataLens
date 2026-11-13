# 验证 cwd = 文件所在目录：直接读旁边的 data.csv
import csv
import os

# utf-8-sig 兼容编辑器另存时加的 BOM，保证首列名仍然是 'name'
with open('data.csv', newline='', encoding='utf-8-sig') as f:
    rows = list(csv.DictReader(f))
print('cwd:', os.getcwd())
for row in rows:
    print(f"  {row['name']}: {row['qty']} x {row['price']}")
print('总计:', sum(float(r['qty']) * float(r['price']) for r in rows))
