import os
import requests
import shutil
from bs4 import BeautifulSoup
import re
from PIL import Image
from io import BytesIO

DOWNLOAD_DIR = 'downloads'

def download_pdf(identifier):
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    identifier = identifier.strip()
    
    if identifier.lower().startswith("http"):
        return _download_direct_url(identifier)
    else:
        return _download_by_book_name(identifier)

def _download_direct_url(url):
    if not url.lower().endswith(".pdf"):
        return {"status": "error", "message": "URL doesn't point to a PDF file"}

    try:
        filename = os.path.join(DOWNLOAD_DIR, url.split("/")[-1])
        response = requests.get(url, stream=True)
        with open(filename, 'wb') as f:
            shutil.copyfileobj(response.raw, f)
        return {"status": "success", "message": f"Downloaded PDF from URL", "file_path": filename}
    except Exception as e:
        return {"status": "error", "message": str(e)}

def _download_by_book_name(book_name):
    clean_name = re.sub(r'\.pdf$', '', book_name, flags=re.IGNORECASE).strip()

    # 1. Try PDFDrive
    pdfdrive_result = _try_pdfdrive_search(clean_name)
    if pdfdrive_result:
        return pdfdrive_result

    # 2. Try Archive.org
    archive_result = _try_archive_search(clean_name)
    if archive_result:
        return archive_result

    # 3. Try Google PDF Search
    google_result = _try_google_pdf_search(clean_name)
    if google_result:
        return google_result

    # 4. Nothing found
    return {
        "status": "error",
        "message": f"Could not find PDF for '{clean_name}'",
        "alternatives": [
            f"https://www.pdfdrive.com/search?q={clean_name.replace(' ', '+')}",
            f"https://archive.org/search.php?query={clean_name.replace(' ', '+')}"
        ]
    }

def _try_pdfdrive_search(book_name):
    print(f"Searching PDFDrive for '{book_name}'...")
    search_url = f"https://www.pdfdrive.com/search?q={book_name.replace(' ', '+')}"
    headers = {'User-Agent': 'Mozilla/5.0'}
    try:
        res = requests.get(search_url, headers=headers, timeout=10)
        soup = BeautifulSoup(res.text, 'html.parser')
        first_result = soup.find('a', class_='ai-search')
        if first_result:
            book_url = "https://www.pdfdrive.com" + first_result['href']
            title = first_result.get('title', book_name)
            pdf_url = _extract_pdfdrive_pdf(book_url)
            if pdf_url:
                return _download_pdf_and_cover(pdf_url, title)
    except Exception as e:
        print("PDFDrive error:", e)
    return None

def _extract_pdfdrive_pdf(book_url):
    try:
        res = requests.get(book_url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=10)
        match = re.search(r'data-preview="(.+?\.pdf)"', res.text)
        if match:
            return match.group(1)
    except Exception as e:
        print("Error getting PDF URL from PDFDrive:", e)
    return None

def _try_archive_search(book_name):
    print(f"Searching Archive.org for '{book_name}'...")
    search_url = f"https://archive.org/advancedsearch.php?q=title%3A({book_name.replace(' ', '+')})&output=json"
    try:
        res = requests.get(search_url, timeout=10)
        docs = res.json().get('response', {}).get('docs', [])
        for doc in docs:
            if 'identifier' in doc:
                item_url = f"https://archive.org/download/{doc['identifier']}/{doc['identifier']}.pdf"
                return _download_pdf_and_cover(item_url, book_name)
    except Exception as e:
        print("Archive.org error:", e)
    return None

def _try_google_pdf_search(book_name):
    print(f"Trying Google PDF search for '{book_name}'...")
    from googlesearch import search
    try:
        query = f"{book_name} filetype:pdf"
        for url in search(query, num_results=5):
            if url.endswith(".pdf"):
                return _download_pdf_and_cover(url, book_name)
    except Exception as e:
        print("Google search error:", e)
    return None

def _download_pdf_and_cover(url, title):
    try:
        pdf_name = re.sub(r'[^\w\s-]', '', title) + '.pdf'
        file_path = os.path.join(DOWNLOAD_DIR, pdf_name)

        # Download PDF
        r = requests.get(url, stream=True, timeout=15)
        with open(file_path, 'wb') as f:
            shutil.copyfileobj(r.raw, f)

        # Try to get a cover image (placeholder)
        cover_path = _download_cover_image(title)

        return {
            "status": "success",
            "message": f"Downloaded '{title}'",
            "file_path": file_path,
            "cover": cover_path
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

def _download_cover_image(book_name):
    try:
        search_url = f"https://www.googleapis.com/books/v1/volumes?q={book_name}"
        res = requests.get(search_url, timeout=10).json()
        items = res.get("items", [])
        if items:
            image_url = items[0]["volumeInfo"]["imageLinks"]["thumbnail"]
            img_res = requests.get(image_url, timeout=10)
            img = Image.open(BytesIO(img_res.content))
            cover_path = os.path.join(DOWNLOAD_DIR, f"{book_name}_cover.jpg")
            img.save(cover_path)
            return cover_path
    except Exception as e:
        print("Cover image not found:", e)
    return None

# --- Example usage (for testing) ---
if __name__ == "__main__":
    import sys
    book = " ".join(sys.argv[1:])
    result = download_pdf(book)
    print(result)
