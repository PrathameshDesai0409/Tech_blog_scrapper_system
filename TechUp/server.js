// server.js - The heart of our backend.
// This file sets up the Express server, defines our API endpoint,
// and schedules the automated scraping job.

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const OpenAI = require('openai');
const session = require('express-session');
const passport = require('passport');
const OAuth2Strategy = require('passport-oauth2').Strategy;

const runScraper = require('./scripts/scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// --- OpenAI Configuration ---
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// --- Session and Passport.js Setup ---
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // For development. Use true in production with HTTPS.
}));

app.use(passport.initialize());
app.use(passport.session());

passport.use('linkedin', new OAuth2Strategy({
    authorizationURL: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenURL: 'https://www.linkedin.com/oauth/v2/accessToken',
    clientID: process.env.LINKEDIN_CLIENT_ID,
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
    callbackURL: "http://localhost:3000/auth/linkedin/callback",
    scope: ['openid', 'profile', 'email', 'w_member_social'],
    state: true
},
async function(accessToken, refreshToken, params, profile, done) {
    // The `profile` argument is empty with this strategy.
    // We need to fetch it manually using the accessToken.
    try {
        const userinfoResponse = await axios.get('https://api.linkedin.com/v2/userinfo', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        const userProfile = userinfoResponse.data;
        // The user's unique LinkedIn ID is in the 'sub' field with OIDC
        const user = { id: userProfile.sub, accessToken: accessToken };
        return done(null, user);
    } catch (error) {
        return done(error);
    }
}));

passport.serializeUser(function(user, done) {
    done(null, user);
});

passport.deserializeUser(function(obj, done) {
    done(null, obj);
});

// --- Middleware ---
// To parse JSON bodies for POST requests
app.use(express.json());
// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));


// --- Authentication Routes ---
app.get('/auth/linkedin', passport.authenticate('linkedin'));

app.get('/auth/linkedin/callback',
  passport.authenticate('linkedin', { failureRedirect: '/' }),
  function(req, res) {
    // Successful authentication. The user is logged in.
    // This window can be closed, and the user can try sharing again.
    res.send('<script>window.opener.location.reload(); window.close();</script>');
  }
);

// Middleware to ensure a user is authenticated
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.status(401).json({ message: 'User not authenticated. Please login.' });
}


// --- API Endpoints ---

// Endpoint to provide summarized stories to the frontend
app.get('/api/stories', (req, res) => {
    const summaryFilePath = path.join(__dirname, 'data', 'summary.json');

    fs.readFile(summaryFilePath, 'utf8', (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                console.log('summary.json not found. Sending empty structure to frontend.');
                return res.json({ business: {}, marketing: {}, ai: {} });
            }
            console.error('Error reading summary file:', err);
            return res.status(500).send('Error loading story data.');
        }
        res.setHeader('Content-Type', 'application/json');
        res.send(data);
    });
});

// Endpoint to share a story on LinkedIn
app.post('/api/share/linkedin', ensureAuthenticated, async (req, res) => {
    const { headline, fullContent, image, originalUrl } = req.body;
    const accessToken = req.user.accessToken;
    const linkedInId = req.user.id;

    try {
        console.log('Humanizing content for LinkedIn...');
        const humanizedText = await humanizeForLinkedIn(headline, fullContent, originalUrl);

        console.log('Uploading image to LinkedIn...');
        const imageUrn = await uploadImageToLinkedIn(accessToken, linkedInId, image);

        console.log('Posting to LinkedIn feed...');
        await createLinkedInPost(accessToken, linkedInId, humanizedText, imageUrn, originalUrl, headline);

        res.status(200).json({ message: 'Successfully posted to LinkedIn!' });

    } catch (error) {
        console.error('Error sharing to LinkedIn:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Failed to share on LinkedIn.' });
    }
});


// --- LinkedIn Sharing Helper Functions ---

async function humanizeForLinkedIn(headline, content, url) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4", // Using a more advanced model for better results
            messages: [{
                role: "system",
                content: "You are a social media manager specializing in creating engaging LinkedIn posts. The user will provide a tech article's headline and content. Your job is to create a compelling and professional LinkedIn post. The post should start with a strong hook, include 2-3 key takeaways from the content, mention the original source, and include relevant hashtags. The tone should be insightful and professional.",
            }, { 
                role: "user",
                content: `Headline: ${headline}\n\nContent: ${content.substring(0, 1500)}\n\nOriginal Source: ${url}`,
            }],
        });
        return response.choices[0].message.content;
    } catch (error) {
        console.error('OpenAI API Error during humanization:', error);
        // Fallback to a simple format if OpenAI fails
        return `${headline}\n\nRead more at: ${url}\n\n#Tech #Innovation`;
    }
}

async function uploadImageToLinkedIn(accessToken, linkedInId, imageUrl) {
    if (!imageUrl || imageUrl.startsWith('https://placehold.co')) {
        console.log('Skipping image upload for placeholder.');
        return null; // Don't upload placeholder images
    }

    // 1. Register the upload
    const registerUploadResponse = await axios.post(
        'https://api.linkedin.com/v2/assets?action=registerUpload',
        {
            "registerUploadRequest": {
                "recipes": ["urn:li:digitalmediaRecipe:feedshare-image"],
                "owner": `urn:li:person:${linkedInId}`,
                "serviceRelationships": [{
                    "relationshipType": "OWNER",
                    "identifier": "urn:li:userGeneratedContent"
                }]
            }
        },
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );

    const uploadUrl = registerUploadResponse.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
    const imageUrn = registerUploadResponse.data.value.asset;

    // 2. Upload the image
    const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    await axios.put(uploadUrl, imageResponse.data, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'image/jpeg' // Assuming JPEG, adjust if needed
        }
    });

    return imageUrn;
}

async function createLinkedInPost(accessToken, linkedInId, text, imageUrn, originalUrl, headline) {
    const postBody = {
        "author": `urn:li:person:${linkedInId}`,
        "lifecycleState": "PUBLISHED",
        "specificContent": {
            "com.linkedin.ugc.ShareContent": {
                "shareCommentary": { "text": text },
                "shareMediaCategory": "ARTICLE",
                "media": [{
                    "status": "READY",
                    "originalUrl": originalUrl,
                    "title": { "text": headline }
                }]
            }
        },
        "visibility": {
            "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
        }
    };

    // Add image to the post if it was uploaded successfully
    if (imageUrn) {
        postBody.specificContent["com.linkedin.ugc.ShareContent"].shareMediaCategory = "IMAGE";
        postBody.specificContent["com.linkedin.ugc.ShareContent"].media[0].media = imageUrn;
    }


    await axios.post('https://api.linkedin.com/v2/ugcPosts', postBody, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        }
    });
}


// --- Automated Cron Job ---
console.log('Scheduling scraper job to run every 12 hours.');
cron.schedule('0 */12 * * *', () => {
    console.log('--- Running scheduled scraper job ---');
    runScraper().catch(console.error);
});


// --- Start the Server ---
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log('Running initial scrape on server start...');
    runScraper().catch(console.error);
});
