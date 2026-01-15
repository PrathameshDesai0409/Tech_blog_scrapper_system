require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const OpenAI = require('openai');

// Configure OpenAI API
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// --- CONFIGURATION ---
const BLOGS_PATH = path.join(__dirname, '..', 'data', 'blogs.json');
const SUMMARY_PATH = path.join(__dirname, '..', 'public', 'data', 'summary.json');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'scraped_history.json');

async function runScraper() {
    console.log('Starting scraper process...');
    const blogsData = JSON.parse(await fs.readFile(BLOGS_PATH, 'utf-8'));
    
    const oldSummaryData = await loadJsonFile(SUMMARY_PATH, { business: {}, marketing: {}, ai: {} });
    const scrapedHistory = new Set(await loadJsonFile(HISTORY_PATH, []));

    const newSummaryData = { business: {}, marketing: {}, ai: {} };

    const oldStoriesMap = new Map();
    for (const domain in oldSummaryData) {
        for (const subdomain in oldSummaryData[domain]) {
            oldSummaryData[domain][subdomain].forEach(story => {
                oldStoriesMap.set(story.originalUrl, story);
            });
        }
    }

    console.log('Scraping sources and rebuilding live summary cache...');

    for (const domain in blogsData) {
        if (!newSummaryData[domain]) newSummaryData[domain] = {};
        for (const subdomain in blogsData[domain]) {
            if (!newSummaryData[domain][subdomain]) newSummaryData[domain][subdomain] = [];
            
            console.log(`\nProcessing [${domain} -> ${subdomain}]`);

            for (const blog of blogsData[domain][subdomain]) {
                try {
                    const articleLinks = await findArticleLinks(blog.url);

                    for (const link of articleLinks) {
                        if (oldStoriesMap.has(link)) {
                            newSummaryData[domain][subdomain].push(oldStoriesMap.get(link));
                            continue; 
                        }
                        if (scrapedHistory.has(link)) {
                            continue;
                        }
                        
                        console.log(`+ Found new article: ${link}`);
                        
                        const article = await scrapeArticleContent(link);
                        if (!article) continue;
                        
                        const summary = await summarizeContent(article.content);
                        
                        if (summary && summary.error === 'AUTH_ERROR') {
                            console.error("CRITICAL: Stopping scraper due to invalid API Key.");
                            return;
                        }
                        if (!summary) continue;

                        const newStory = {
                            image: article.image || `https://placehold.co/600x400/1a2b3c/ffffff?text=${encodeURIComponent(blog.name)}`,
                            headline: article.headline,
                            summary: summary.summary,
                            keywords: summary.keywords,
                            source: blog.name,
                            date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                            originalUrl: link,
                            fullContent: article.content,
                        };

                        newSummaryData[domain][subdomain].push(newStory);
                        scrapedHistory.add(link);
                        console.log(`  - Summarized and added to history.`);
                    }
                } catch (error) {
                    console.error(`Error processing ${blog.name} (${blog.url}):`, error.message);
                }
            }
        }
    }

    // Ensure the directory exists before writing
    const summaryDir = path.dirname(SUMMARY_PATH);
    try {
        await fs.mkdir(summaryDir, { recursive: true });
    } catch (err) { /* ignore if exists */ }

    await fs.writeFile(SUMMARY_PATH, JSON.stringify(newSummaryData, null, 2));
    await fs.writeFile(HISTORY_PATH, JSON.stringify(Array.from(scrapedHistory), null, 2));
    console.log('\nScraper process finished. summary.json has been rebuilt with live articles.');
}

/**
 * A helper function to safely load a JSON file, returning a default if it fails.
 */
async function loadJsonFile(filePath, defaultValue) {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.log(`No existing ${path.basename(filePath)} found. Initializing fresh.`);
        return defaultValue;
    }
}

/**
 * Visits a blog's main page and tries to find links to individual articles.
 */
async function findArticleLinks(blogUrl) {
    try {
        const { data } = await axios.get(blogUrl, {
             headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });
        const $ = cheerio.load(data);
        const links = new Set();
        
        $('a[href*="/202"], a[href*="/blog/"], a[href*="/news/"], a[href*="/article/"], a[href*="/insights/"], a[href*="/perspectives/"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                try {
                    // Filter out non-article pages (categories, tags, pagination, authors)
                    if (href.includes('/category/') || href.includes('/tag/') || href.includes('/page/') || href.includes('/author/')) {
                        return;
                    }
                    const absoluteUrl = new URL(href, blogUrl).href;
                    links.add(absoluteUrl);
                } catch (e) { /* Ignore invalid URLs */ }
            }
        });

        if (links.size === 0) {
            console.log(`  - No article links found on ${blogUrl} with current selectors.`);
        }

        return Array.from(links).slice(0, 10); // Limit to checking the 10 most prominent links
    } catch (error) {
        console.error(`Failed to find article links on ${blogUrl}: ${error.message}`);
        return [];
    }
}

/**
 * Scrapes the content of a single article from a given URL.
 */
async function scrapeArticleContent(articleUrl) {
    try {
        const { data } = await axios.get(articleUrl, {
             headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
        });
        const $ = cheerio.load(data);
        
        const headline = $('h1').first().text().trim();
        const content = $('p').text().substring(0, 3000);
        let image = $('meta[property="og:image"]').attr('content');

        if (image) {
            image = new URL(image, articleUrl).href;
        }

        if (!headline || !content) {
            console.log(`  - Could not find headline/content for ${articleUrl}`);
            return null;
        }
        return { headline, content, image };
    } catch (error) {
        console.error(`  - Failed to scrape content from ${articleUrl}: ${error.message}`);
        return null;
    }
}

/**
 * Sends content to OpenAI API for summarization and keyword extraction.
 */
async function summarizeContent(content) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{
                role: "system",
                content: "You are a helpful assistant that summarizes tech articles. The user will provide an article text. Your job is to provide a JSON object with two keys: 'summary' (a neutral, factual summary between 40-50 words) and 'keywords' (an array of 3-4 top keywords).",
            }, {
                role: "user",
                content: content,
            }],
            response_format: { "type": "json_object" },
        });
        const result = JSON.parse(response.choices[0].message.content);
        return result;
    } catch (error) {
        console.error('OpenAI API Error:', error.message);
        if (error.status === 401) {
            return { error: 'AUTH_ERROR' };
        }
        return null;
    }
}

module.exports = runScraper;

// If the script is run directly, execute it.
if (require.main === module) {
    runScraper();
}
