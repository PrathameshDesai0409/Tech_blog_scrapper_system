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
        # Note: In a production environment, you might want to run the scraper
        # on a schedule rather than on every API call. For this project,
        # running it on-demand is fine.
        data = asyncio.run(get_all_blog_data())
        return jsonify(data)
        
    except Exception as e:
        # A more detailed error for the server console
        print(f"An error occurred in /api/data: {e}")
        return jsonify({"error": "Failed to scrape data", "details": str(e)}), 500

if __name__ == '__main__':
    # It's recommended to run a production server like Gunicorn or Waitress
    # instead of Flask's built-in server for a real application.
    app.run(debug=True, port=5000)
