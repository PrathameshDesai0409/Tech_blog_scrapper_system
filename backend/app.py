import asyncio
from flask import Flask, jsonify
from flask_cors import CORS
from blog_scraper import get_all_blog_data
from blog_scraper import BLOG_DATA
import httpx

app = Flask(__name__)

CORS(app)

@app.route('/api/data')
def get_scraped_data():
    try:
        data = asyncio.run(get_all_blog_data())
        return jsonify(data)
        
    except Exception as e:
        return jsonify({"error": "Failed to scrape data", "details": str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True)
