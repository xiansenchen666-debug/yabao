import sys
from pypdf import PdfReader

try:
    reader = PdfReader("完整的“AI”自习室+AI技能培训+本地部署(1).pdf")
    text = ""
    for page in reader.pages:
        text += page.extract_text() + "\n"
    with open("pdf_content.txt", "w", encoding="utf-8") as f:
        f.write(text)
    print("Success")
except Exception as e:
    print(e)
