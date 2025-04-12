import os
import requests
import shutil
from bs4 import BeautifulSoup
import re
from PIL import Image
from io import BytesIO
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

DOWNLOAD_DIR = 'downloads'
MAX_CONCURRENT_DOWNLOADS = 10

def download_pdf(identifier):
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    identifier = identifier.strip()

    if identifier.lower().startswith("http"):
        return _download_direct_url(identifier)
    elif "past paper" in identifier.lower() or "exam paper" in identifier.lower():
        return _try_past_paper_download(identifier)
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

        # Get cover image (optional)
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

def _try_past_paper_download(identifier):
    print(f"Searching academic sources for '{identifier}'...")
    try:
        course_code = _extract_course_code(identifier)
        year = _extract_year(identifier)
        
        # 1. First try MZUNI OPAC
        mzuni_result = _try_mzuni_opac_search(identifier, course_code, year)
        if mzuni_result and mzuni_result.get('status') == 'success':
            return mzuni_result
            
        # 2. Fallback to general academic search
        return {
            "status": "info",
            "message": "No direct download found. Try these resources:",
            "resources": [
                f"https://opac.mzuni.ac.mw/cgi-bin/koha/opac-search.pl?q={identifier.replace(' ', '+')}",
                "https://www.academia.edu/",
                "https://www.researchgate.net/"
            ],
            "tips": [
                "Try searching with exact course code and year (e.g. 'CS 101 2020')",
                "Some resources may require institutional login"
            ]
        }
        
    except Exception as e:
        return {"status": "error", "message": f"Search error: {str(e)}"}

def _try_mzuni_opac_search(query, course_code=None, year=None):
    """Enhanced MZUNI OPAC search with better error handling"""
    try:
        search_url = f"https://opac.mzuni.ac.mw/cgi-bin/koha/opac-search.pl?q={query.replace(' ', '+')}"
        headers = {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'text/html,application/xhtml+xml'
        }
        
        response = requests.get(search_url, headers=headers, timeout=15)
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # Look for download links - this will vary based on OPAC actual page structure
        download_links = []
        for link in soup.find_all('a', href=True):
            href = link['href'].lower()
            if href.endswith('.pdf') or 'download' in href:
                full_url = href if href.startswith('http') else f"https://opac.mzuni.ac.mw{href}"
                download_links.append(full_url)
        
        if download_links:
            # Try to download the first available PDF
            pdf_url = download_links[0]
            filename = f"{course_code or 'paper'}_{year or 'unknown'}.pdf" if course_code or year else "past_paper.pdf"
            
            file_path = os.path.join(DOWNLOAD_DIR, filename)
            r = requests.get(pdf_url, stream=True, timeout=20)
            with open(file_path, 'wb') as f:
                shutil.copyfileobj(r.raw, f)
                
            return {
                "status": "success",
                "message": f"Downloaded past paper: {query}",
                "file_path": file_path,
                "source": "MZUNI Library"
            }
        
        return None
        
    except Exception as e:
        print(f"MZUNI OPAC search error: {str(e)}")
        return None

def _extract_course_code(text):
    # Try to extract course codes like "BICT2302", "COMM1101", 
    match = re.search(r'([A-Za-z]{2,4}\s?\d{3})', text)
    return match.group(1) if match else None

def _extract_year(text):
    # Try to extract 4-digit years
    match = re.search(r'(20\d{2})', text)
    return match.group(1) if match else None

# ---------- Multiple download queue ----------
def handle_multiple_downloads(book_list):
    results = []
    with ThreadPoolExecutor(max_workers=MAX_CONCURRENT_DOWNLOADS) as executor:
        future_to_book = {executor.submit(download_pdf, book): book for book in book_list}
        for future in as_completed(future_to_book):
            book = future_to_book[future]
            try:
                data = future.result()
                results.append(data)
            except Exception as e:
                results.append({"status": "error", "message": str(e), "book": book})
    return results

# --- MAIN MAIN ---
if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        query = " ".join(sys.argv[1:])
        result = download_pdf(query)
        print(result)
    else:
        # Batch test with MZUNI past paper examples
        books = [
            "Atomic Habits", 
            "past paper BICT2303 2023", 
            "exam paper COMM1101 2024",
            "Python Crash Course"
        ]
        results = handle_multiple_downloads(books)
        for r in results:
            print(r)