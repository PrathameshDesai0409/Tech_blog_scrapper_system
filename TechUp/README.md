# TechUp 🚀

TechUp is an automated, full-stack tech blog scraper and AI-powered social media publishing tool. 

It aggregates top tech, business, and marketing news, summarizes the content using OpenAI, and displays it in a beautiful, responsive glassmorphism UI. Additionally, it features a seamless LinkedIn integration that allows users to generate AI-crafted posts and custom DALL-E 3 images directly from the feed.

## ✨ Features

- **Automated Web Scraping:** Runs a scheduled background job (via `node-cron`) to scrape designated tech and business blogs using `cheerio`.
- **AI-Powered Summarization:** Uses OpenAI's `gpt-3.5-turbo` to automatically summarize lengthy articles into crisp, 40-50 word summaries and extract key tags/keywords.
- **Modern Glassmorphism UI:** A sleek, mobile-optimized frontend built with vanilla HTML/CSS/JS, utilizing `Swiper.js` for an intuitive swipeable feed.
- **Smart Caching:** Avoids redundant scraping and excessive API costs by maintaining a localized history state (`scraped_history.json`) and data cache (`summary.json`).
- **LinkedIn OAuth & Publishing:** Authenticate with LinkedIn via `passport-oauth2` to publish directly to user feeds or organization pages.
- **AI Post & Image Generation:** Automatically drafts professional LinkedIn posts based on scraped articles and can optionally generate abstract, text-free DALL-E 3 images to accompany the post.
- **Dynamic Watermarking:** Uses `sharp` to dynamically composite a custom logo onto original or AI-generated images before posting them to LinkedIn.

## 🛠️ Tech Stack

**Frontend:**
- HTML5, CSS3, Vanilla JavaScript
- Swiper.js (Swipe gestures & carousels)
- Font Awesome (Icons)

**Backend:**
- Node.js & Express.js
- Axios & Cheerio (Web Scraping)
- OpenAI API (Summarization, Text generation, DALL-E 3)
- Passport.js (LinkedIn OAuth2)
- Sharp (High-performance image processing)
- node-cron (Task scheduling)

## ⚙️ Prerequisites

Before you begin, ensure you have the following:
1. **Node.js** installed (v16.x or higher recommended).
2. An **OpenAI API Key**.
3. A **LinkedIn Developer App** with the following scopes enabled:
   - `openid`, `profile`, `email` (Sign In with LinkedIn)
   - `w_member_social` (Share on LinkedIn)
   - `w_organization_social`, `r_organization_admin` (Optional: To post on behalf of company pages)

## 🚀 Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/techup.git
   cd techup
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Environment Variables:**
   Create a `.env` file in the root of your project and add the following keys:
   ```env
   PORT=3000
   NODE_ENV=development
   SESSION_SECRET=your_super_secret_session_key
   
   # OpenAI
   OPENAI_API_KEY=sk-your_openai_api_key_here
   
   # LinkedIn OAuth
   LINKEDIN_CLIENT_ID=your_linkedin_client_id
   LINKEDIN_CLIENT_SECRET=your_linkedin_client_secret
   ```

4. **Prepare the Data Directories:**
   Ensure the following directories exist in your project root for the scraper to function correctly:
   - `data/blogs.json` (Needs to contain the URLs of the blogs you wish to scrape, structured by domain/subdomain).
   - `public/data/` (Where `summary.json` will be generated).
   - `public/logo/logo.png` (If using the "Include Logo" feature for LinkedIn sharing).

## 🏃‍♂️ Running the Application

**To start the Express server:**
```bash
node server.js
```
The server will be running at `http://localhost:3000`.

**To run the scraper manually:**
```bash
node scripts/scraper.js
```
*(Note: The scraper is already scheduled to run automatically every day at 5:00 PM EST via `node-cron` inside `server.js`).*

## 📂 Project Structure

```text
TechUp/
├── public/             # Static frontend assets (HTML, CSS, JS, logo, etc.)
├── data/               # Configuration and historical data files
├── scripts/
│   └── scraper.js      # Dedicated scraping and summarization script
├── server.js           # Express backend, LinkedIn OAuth, and API routes
├── package.json        # Dependencies and scripts
└── .env                # Secret environment variables
```

## 📝 License
This project is licensed under the MIT License.