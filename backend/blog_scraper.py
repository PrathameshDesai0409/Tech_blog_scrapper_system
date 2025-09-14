# backend/blog_scraper.py

import asyncio
import httpx
from bs4 import BeautifulSoup
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
API_KEY = "API_KEY" 

try:
    if not API_KEY or API_KEY == "your-api-key-goes-here" or "xxxxxxxx" in API_KEY:
        print("ERROR: Please replace the sample API key with your actual OpenAI API key.")
        client = None
    else:
        client = OpenAI(api_key=API_KEY)
except Exception as e:
    print(f"Error initializing OpenAI client: {e}")
    client = None

BLOG_DATA = {
    "B2B Marketing": [
        {"name": "Animalz Blog", "url": "https://www.animalz.co/blog/"},
        {"name": "SaaStr", "url": "https://www.saastr.com/"},
        {"name": "B2B Marketing Blog", "url": "https://www.b2bmarketing.net/en-gb/resources/blog"},
        {"name": "Superpath Blog", "url": "https://superpath.co/blog"}
    ],
    "Digital Marketing": [
        {"name": "HubSpot Marketing Blog", "url": "https://blog.hubspot.com/marketing"},
        {"name": "Neil Patel Blog", "url": "https://neilpatel.com/blog/"},
        {"name": "Moz Blog", "url": "https://moz.com/blog"},
        {"name": "MarketingProfs Blog", "url": "https://www.marketingprofs.com/articles"},
        {"name": "Search Engine Land", "url": "https://searchengineland.com/"}
    ],
    "Specialized Marketing": [
        {"name": "Litmus Blog", "url": "https://www.litmus.com/blog/"},
        {"name": "Hootsuite Blog", "url": "https://blog.hootsuite.com/"},
        {"name": "Content Marketing Institute", "url": "https://contentmarketinginstitute.com/blog/"},
        {"name": "Convince & Convert Blog", "url": "https://www.convinceandconvert.com/blog/"},
        {"name": "Unbounce Blog", "url": "https://unbounce.com/blog/"}
    ]
}
HISTORY_FILE = 'history.json'
SUMMARY_CACHE_FILE = 'summary_cache.json'
MAX_CACHE_SIZE = 1000 # Set a maximum number of summaries to cache
STOP_WORDS = set(['a', 'an', 'the', 'and', 'but', 'if', 'or', 'because', 'as', 'what', 'which', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 'should', 'now', 'd', 'll', 'm', 'o', 're', 've', 'y', 'ain', 'aren', 'couldn', 'didn', 'doesn', 'hadn', 'hasn', 'haven', 'isn', 'ma', 'mightn', 'mustn', 'needn', 'shan', 'shouldn', 'wasn', 'weren', 'won', 'wouldn', 'your', 'b2b', 'marketing', 'content', 'how', 'to', 'your', 'you', 'for', 'the', 'and', 'in', 'of', 'with', 'on', 'at', 'by', 'from', 'its', 'vs'])
POSITIVE_WORDS = set(['amazing', 'growth', 'success', 'effective', 'powerful', 'boost', 'win', 'improve', 'best', 'top', 'new', 'innovative'])
NEGATIVE_WORDS = set(['mistakes', 'avoid', 'bad', 'fail', 'problem', 'risk', 'warning', 'stop', 'decline', 'worst', 'never'])

# --- ANALYSIS & AI FUNCTIONS ---

def analyze_sentiment(text):
    score = 0
    words = set(re.findall(r'\b\w+\b', text.lower()))
    for word in words:
        if word in POSITIVE_WORDS: score += 1
        elif word in NEGATIVE_WORDS: score -= 1
    if score > 0: return 'Positive'
    if score < 0: return 'Negative'
    return 'Neutral'

def count_syllables(word):
    word = word.lower()
    count = 0
    vowels = "aeiouy"
    if word and word[0] in vowels: count += 1
    for index in range(1, len(word)):
        if word[index] in vowels and word[index - 1] not in vowels: count += 1
    if word.endswith("e"): count -= 1
    if count == 0: count += 1
    return count

def calculate_readability(text):
    try:
        words = text.split()
        num_words = len(words)
        if num_words == 0: return "N/A"
        num_sentences = text.count('.') + text.count('!') + text.count('?')
        if num_sentences == 0: num_sentences = 1
        num_syllables = sum(count_syllables(word) for word in words)
        score = 0.39 * (num_words / num_sentences) + 11.8 * (num_syllables / num_words) - 15.59
        grade_level = round(score)
        if grade_level >= 16: return "Post-Graduate"
        if grade_level >= 13: return "College Level"
        if grade_level >= 9: return "High School"
        if grade_level >= 6: return "Middle School"
        return "Easy to Read"
    except Exception:
        return "N/A"

async def get_ai_summary(full_text):
    if not client:
        return "OpenAI client not initialized. Please set your API key in the script."
    try:
        truncated_text = " ".join(full_text.split()[:1500])
        completion = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": "You are a helpful assistant that summarizes articles concisely."},
                {"role": "user", "content": f"Please summarize the following article in one concise paragraph, strictly between 25 and 30 words: {truncated_text}"}
            ]
        )
        return completion.choices[0].message.content
    except Exception as e:
        return f"AI summary failed: {e}"

# --- CORE SCRAPING LOGIC ---

async def fetch_article_details(session, post_url):
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        response = await session.get(post_url, headers=headers, timeout=10, follow_redirects=True)
        response.raise_for_status()
        soup = BeautifulSoup(response.content, 'html.parser')
        
        paragraphs = soup.find_all('p', string=True)
        full_text = " ".join([p.get_text(strip=True) for p in paragraphs])
        og_image = soup.find('meta', property='og:image')
        image_url = og_image['content'] if og_image else None
        time_tag = soup.find('time')
        publish_date = time_tag['datetime'] if time_tag and time_tag.has_attr('datetime') else "N/A"

        return {
            "full_text": full_text if full_text else "No content found.",
            "image_url": image_url,
            "publish_date": publish_date
        }
    except Exception:
        return {"full_text": "Could not load article content.", "image_url": None, "publish_date": "N/A"}

async def scrape_single_blog(session, blog_info, category, summary_cache, post_limit=2):
    url = blog_info["url"]
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        response = await session.get(url, headers=headers, timeout=15, follow_redirects=True)
        response.raise_for_status()
        soup = BeautifulSoup(response.content, 'html.parser')
        
        posts = []
        potential_links = soup.select('h2 a, h3 a, article a')
        
        for link in potential_links:
            if len(posts) >= post_limit: break
            if link.has_attr('href') and link.get_text(strip=True):
                post_title = link.get_text(strip=True)
                post_url = link['href']
                
                if not any(p['title'] == post_title for p in posts) and len(post_title.split()) > 3:
                    if not post_url.startswith('http'): post_url = urljoin(url, post_url)
                    
                    ai_summary = ""
                    if post_url in summary_cache:
                        ai_summary = summary_cache[post_url]
                    else:
                        details = await fetch_article_details(session, post_url)
                        ai_summary = await get_ai_summary(details["full_text"])
                        summary_cache[post_url] = ai_summary
                    
                    details = await fetch_article_details(session, post_url)
                    
                    posts.append({
                        'title': post_title,
                        'url': post_url,
                        'snippet': ai_summary,
                        'image_url': details['image_url'],
                        'publish_date': details['publish_date'],
                        'sentiment': analyze_sentiment(post_title),
                        'readability': calculate_readability(ai_summary)
                    })
        
        final_result = { "name": blog_info["name"], "url": url, "category": category }
        if not posts: final_result["error"] = "Could not find any post links."
        else: final_result["posts"] = posts

        return final_result
    except Exception as e:
        return {"name": blog_info["name"], "url": url, "category": category, "error": f"An error occurred: {str(e)}"}

async def get_all_blog_data():
    previous_keywords = {}
    if os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE, 'r') as f: previous_keywords = json.load(f)

    summary_cache = {}
    if os.path.exists(SUMMARY_CACHE_FILE):
        with open(SUMMARY_CACHE_FILE, 'r') as f: summary_cache = json.load(f)

    # --- NEW: Pruning the summary cache ---
    if len(summary_cache) > MAX_CACHE_SIZE:
        # Convert to list of items, take the most recent ones, convert back to dict
        items = list(summary_cache.items())
        trimmed_items = items[-MAX_CACHE_SIZE:]
        summary_cache = dict(trimmed_items)
        print(f"CACHE: Pruned summary cache to {len(summary_cache)} entries.")
    
    scraped_data = {category: [] for category in BLOG_DATA.keys()}
    async with httpx.AsyncClient() as session:
        tasks = []
        for category, blogs in BLOG_DATA.items():
            for blog_info in blogs:
                tasks.append(scrape_single_blog(session, blog_info, category, summary_cache))
        
        results = await asyncio.gather(*tasks)

    current_keywords_for_history = {}
    for result in results:
        category = result.get("category")
        if category and category in scraped_data:
            if 'posts' in result:
                all_titles = " ".join([p['title'] for p in result['posts']])
                words = re.findall(r'\b\w+\b', all_titles.lower())
                filtered_words = [word for word in words if word not in STOP_WORDS and len(word) > 3]
                current_counts = Counter(filtered_words)
                current_keywords_for_history[result['name']] = dict(current_counts)
                previous_counts = previous_keywords.get(result['name'], {})
                keywords_with_trends = []
                for word, count in current_counts.most_common(5):
                    trend = 'stable'
                    if word not in previous_counts: trend = 'new'
                    elif count > previous_counts[word]: trend = 'up'
                    elif count < previous_counts[word]: trend = 'down'
                    keywords_with_trends.append({'keyword': word, 'trend': trend})
                result['keywords'] = keywords_with_trends
            scraped_data[category].append(result)

    with open(HISTORY_FILE, 'w') as f: json.dump(current_keywords_for_history, f, indent=2)
    with open(SUMMARY_CACHE_FILE, 'w') as f: json.dump(summary_cache, f, indent=2)
            
    return scraped_data

