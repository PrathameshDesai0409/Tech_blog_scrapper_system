import os
import json
import asyncio
import httpx
import re
from bs4 import BeautifulSoup
from collections import Counter
from urllib.parse import urljoin
import re
from collections import Counter
import json
import os
from openai import OpenAI

# --- Main Configuration ---

# --- THIS IS THE CHANGE ---
# Paste your OpenAI API key directly here.
# WARNING: Do not share this file publicly with your key inside.
API_KEY = "" 

client = None
if not API_KEY:
    print("ERROR: OPENAI_API_KEY not found in .env file. LLM features will be disabled.")
else:
    client = AsyncOpenAI(api_key=API_KEY)

# --- LLM CATEGORIZATION SETUP ---
# The LLM will be instructed to choose from these categories. This structure
# directly maps to what the index.html file expects.
CATEGORIES = {
    "Technology": ["AI", "Quantum", "Eco Tech", "Software", "Hardware", "Cybersecurity"],
    "Business": ["Marketing", "Supply Chain", "Work", "Economy", "Startups", "Finance"],
    "Lifestyle": ["Home", "Wellness", "Travel", "Food", "Productivity", "Health"]
}

# --- FILE & CACHE SETUP ---
BLOG_SOURCES_FILE = 'blogs.json'
HISTORY_FILE = 'history.json'
SUMMARY_CACHE_FILE = 'summary_cache.json'
MAX_CACHE_SIZE = 500

# Load blog sources from JSON to be available for import by other scripts like app.py.
try:
    with open(BLOG_SOURCES_FILE, 'r') as f:
        BLOG_DATA = json.load(f)
except FileNotFoundError:
    print(f"ERROR: {BLOG_SOURCES_FILE} not found. Please create it.")
    BLOG_DATA = []
except json.JSONDecodeError:
    print(f"ERROR: Could not decode {BLOG_SOURCES_FILE}. Please check its format.")
    BLOG_DATA = []


# --- ANALYSIS & HELPER SETUP (from your original code) ---
STOP_WORDS = set(['a', 'an', 'the', 'and', 'but', 'if', 'or', 'because', 'as', 'what', 'which', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now', 'd', 'll', 'm', 'o', 're', 've', 'y', 'ain', 'aren', 'couldn', 'didn', 'doesn', 'hadn', 'hasn', 'haven', 'isn', 'ma', 'mightn', 'mustn', 'needn', 'shan', 'shouldn', 'wasn', 'weren', 'won', 'wouldn', 'your', 'b2b', 'marketing', 'content', 'how', 'to', 'your', 'you', 'for', 'the', 'and', 'in', 'of', 'with', 'on', 'at', 'by', 'from', 'its', 'vs'])
POSITIVE_WORDS = set(['amazing', 'growth', 'success', 'effective', 'powerful', 'boost', 'win', 'improve', 'best', 'top', 'new', 'innovative'])
NEGATIVE_WORDS = set(['mistakes', 'avoid', 'bad', 'fail', 'problem', 'risk', 'warning', 'stop', 'decline', 'worst', 'never'])

# --- BROWSER-LIKE HEADERS TO AVOID 403 ERRORS ---
REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
    'Accept-Language': 'en-US,en;q=0.9',
}

# --- ANALYSIS & AI FUNCTIONS ---

async def get_llm_category(text_to_classify):
    if not client:
        print("ERROR: OpenAI client not initialized. Cannot categorize.")
        return {"main_category": "Business", "sub_category": "Marketing"} # Fallback

    system_prompt = f"""
    You are an expert content classifier. Your task is to categorize article text into the most appropriate main and sub-category.
    You MUST respond with a single, valid JSON object with keys "main_category" and "sub_category".
    The available categories are:
    {json.dumps(CATEGORIES, indent=2)}
    """
    user_prompt = f"Please categorize this article text:\n\n\"{text_to_classify[:1000]}\""

    try:
        completion = await client.chat.completions.create(
            model="gpt-3.5-turbo-1106",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ]
        )
        parsed_json = json.loads(completion.choices[0].message.content)
        main_cat, sub_cat = parsed_json.get("main_category"), parsed_json.get("sub_category")

        if main_cat in CATEGORIES and sub_cat in CATEGORIES.get(main_cat, []):
            return parsed_json
        else:
            print(f"WARN: LLM returned invalid category: {parsed_json}. Falling back.")
            return {"main_category": "Business", "sub_category": "Marketing"}

    except Exception as e:
        print(f"ERROR: OpenAI API call failed: {e}")
        return {"main_category": "Business", "sub_category": "Marketing"}

def analyze_sentiment(text):
    score = 0
    words = set(re.findall(r'\b\w+\b', text.lower()))
    score += sum(1 for word in words if word in POSITIVE_WORDS)
    score -= sum(1 for word in words if word in NEGATIVE_WORDS)
    if score > 0: return 'Positive'
    if score < 0: return 'Negative'
    return 'Neutral'

# --- CORE SCRAPING LOGIC ---

async def fetch_article_details_and_categorize(session, post_url, summary_cache):
    cached_item = summary_cache.get(post_url)
    if isinstance(cached_item, dict):
        return cached_item

    try:
        response = await session.get(post_url, headers=REQUEST_HEADERS, timeout=10)
        response.raise_for_status()
        html_content = response.content.decode('utf-8', errors='replace')
        soup = BeautifulSoup(html_content, 'html.parser')
        
        paragraphs = soup.find_all('p', string=True)
        full_text = " ".join(p.get_text(strip=True) for p in paragraphs if p.get_text(strip=True))
        summary = " ".join(full_text.split()[:150])
        
        category_data = await get_llm_category(summary)
        
        og_image = soup.find('meta', property='og:image')
        image_url = og_image['content'] if og_image else None
        
        result = {
            "summary": summary, "image_url": image_url,
            "main_category": category_data["main_category"], "sub_category": category_data["sub_category"]
        }
        summary_cache[post_url] = result
        return result
    except Exception as e:
        print(f"Error fetching details for {post_url}: {e}")
        return None

async def scrape_single_blog(session, browser, blog_info, summary_cache, post_limit=2):
    url, blog_name = blog_info["url"], blog_info["name"]
    print(f"Scraping {blog_name}...")
    
    page = await browser.new_page()
    processed_posts = []
    try:
        await page.goto(url, timeout=60000, wait_until='domcontentloaded')
        # Wait for potential dynamic content to load
        await page.wait_for_timeout(5000) 
        html_content = await page.content()
        soup = BeautifulSoup(html_content, 'html.parser')

        potential_links = soup.select('h2 a, h3 a, article a')
        unique_urls = set()

        for link_tag in potential_links:
            if len(processed_posts) >= post_limit: break
            
            if link_tag.has_attr('href') and link_tag.get_text(strip=True):
                post_title = link_tag.get_text(strip=True)
                post_url = urljoin(url, link_tag['href'])
                
                if post_url not in unique_urls and len(post_title.split()) > 3:
                    unique_urls.add(post_url)
                    details = await fetch_article_details_and_categorize(session, post_url, summary_cache)
                    if details:
                        processed_posts.append({
                            'title': post_title, 'url': post_url, 'summary': details['summary'],
                            'imageUrl': details['image_url'], 'source': blog_name, 'author': "N/A",
                            'main_category': details['main_category'], 'sub_category': details['sub_category']
                        })
        
        print(f"Found {len(processed_posts)} posts for {blog_name}.")
    except Exception as e:
        print(f"ERROR: Could not scrape {blog_name}: {e}")
    finally:
        await page.close()

    return processed_posts

async def get_all_blog_data():
    if not BLOG_DATA:
        print("ERROR: Blog data sources are empty.")
        return {}

    summary_cache = {}
    if os.path.exists(SUMMARY_CACHE_FILE):
        with open(SUMMARY_CACHE_FILE, 'r') as f: summary_cache = json.load(f)

    if len(summary_cache) > MAX_CACHE_SIZE:
        items = list(summary_cache.items())
        summary_cache = dict(items[-MAX_CACHE_SIZE:])

    final_data = {main_cat: {} for main_cat in CATEGORIES.keys()}
    
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        async with httpx.AsyncClient(http2=True, headers=REQUEST_HEADERS) as session:
            tasks = [scrape_single_blog(session, browser, blog_info, summary_cache) for blog_info in BLOG_DATA]
            results = await asyncio.gather(*tasks)
            
            all_scraped_posts = [post for post_list in results for post in post_list]

            for post in all_scraped_posts:
                main_cat, sub_cat = post["main_category"], post["sub_category"]
                if main_cat in final_data:
                    final_data[main_cat].setdefault(sub_cat, []).append({k: v for k, v in post.items() if k not in ['main_category', 'sub_category']})
        await browser.close()

    final_data = {k: v for k, v in final_data.items() if v}
    with open(SUMMARY_CACHE_FILE, 'w') as f: json.dump(summary_cache, f, indent=2)
    
    return final_data

if __name__ == '__main__':
    print("Starting blog scrape...")
    data = asyncio.run(get_all_blog_data())
    print("\n--- SCRAPING COMPLETE ---")
    print(json.dumps(data, indent=2))

