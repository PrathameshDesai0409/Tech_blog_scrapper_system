// scraper.js - The workhorse of our application.
// It reconstructs the summary cache on each run to ensure it only
// contains articles currently visible on the source blogs.

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
const SUMMARY_PATH = path.join(__dirname, '..', 'data', 'summary.json');
const HISTORY_PATH = path.join(__dirname, '..', 'data', 'scraped_history.json');

/**
 * Main function to orchestrate the scraping and summarizing process.
 */
async function runScraper() {
    console.log('Starting scraper process...');
    const blogsData = JSON.parse(await fs.readFile(BLOGS_PATH, 'utf-8'));
    
    // Load existing summary data and the permanent scraping history
    const oldSummaryData = await loadJsonFile(SUMMARY_PATH, { business: {}, marketing: {}, ai: {} });
    const scrapedHistory = new Set(await loadJsonFile(HISTORY_PATH, []));

    // This will be our new, clean summary data object for this run.
    const newSummaryData = { business: {}, marketing: {}, ai: {} };

    // Create a flat map of old stories (URL -> story object) for quick lookups.
    // This is more efficient than searching through arrays repeatedly.
    const oldStoriesMap = new Map();
    for (const domain in oldSummaryData) {
        for (const subdomain in oldSummaryData[domain]) {
            oldSummaryData[domain][subdomain].forEach(story => {
                oldStoriesMap.set(story.originalUrl, story);
            });
        }
    }

    console.log('Scraping sources and rebuilding live summary cache...');

    // Iterate through all our configured blog sources
    for (const domain in blogsData) {
        if (!newSummaryData[domain]) newSummaryData[domain] = {};
        for (const subdomain in blogsData[domain]) {
            if (!newSummaryData[domain][subdomain]) newSummaryData[domain][subdomain] = [];
            
            console.log(`\nProcessing [${domain} -> ${subdomain}]`);

            for (const blog of blogsData[domain][subdomain]) {
                try {
                    // Step 1: Find all currently live article links on the blog's main page.
                    const articleLinks = await findArticleLinks(blog.url);

                    for (const link of articleLinks) {
                        // Step 2: Check if this live article is one we've already summarized.
                        if (oldStoriesMap.has(link)) {
                            // If yes, we keep it by adding it to our new summary data.
                            newSummaryData[domain][subdomain].push(oldStoriesMap.get(link));
                            continue; // Move to the next link.
                        }

                        // Step 3: If not in our active summary, check if it's in our permanent history.
                        // If so, we've processed it before and won't do it again.
                        if (scrapedHistory.has(link)) {
                            continue;
                        }
                        
                        // Step 4: If we reach here, it's a brand new article. Let's process it.
                        console.log(`+ Found new article: ${link}`);
                        
                        const article = await scrapeArticleContent(link);
                        if (!article) continue;
                        
                        const summary = await summarizeContent(article.content);
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

                        // Add the new story to our new summary and to the permanent history.
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

    // Step 5: After processing all sources, overwrite the old files.
    // The newSummaryData now contains ONLY articles that are currently live.
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
        const image = $('meta[property="og:image"]').attr('content');

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
        return null;
    }
}

module.exports = runScraper;

// If the script is run directly, execute it.
if (require.main === module) {
    runScraper();
}

