const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const fs = require('fs');
const axios = require('axios');
const OpenAI = require('openai');
const session = require('express-session');
const passport = require('passport');
const OAuth2Strategy = require('passport-oauth2').Strategy;
const sharp = require('sharp');
const cors = require('cors');

const runScraper = require('./scripts/scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from your Netlify frontend
app.use(cors({
    origin: ['http://localhost:3000', 'https://techup-flairloop.netlify.app'],
    credentials: true
}));

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
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET, // Make sure you have a .env file with your actual callback URL
    callbackURL: process.env.LINKEDIN_CALLBACK_URL || "http://localhost:3000/auth/linkedin/callback",
    scope: ['openid', 'profile', 'email', 'w_member_social'],
    state: true
},
async function(accessToken, refreshToken, params, profile, done) {
    try {
        const userinfoResponse = await axios.get('https://api.linkedin.com/v2/userinfo', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const userProfile = userinfoResponse.data;
        const user = { id: userProfile.sub, personUrn: `urn:li:person:${userProfile.sub}`, accessToken: accessToken };
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
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));


// --- Authentication Routes ---
app.get('/auth/linkedin', passport.authenticate('linkedin'));

app.get('/auth/linkedin/callback',
  passport.authenticate('linkedin', { failureRedirect: '/' }),
  function(req, res) {
    res.send('<script>window.opener.location.reload(); window.close();</script>');
  }
);

function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) { return next(); }
    res.status(401).json({ message: 'User not authenticated. Please login.' });
}


// --- API Endpoints ---
app.get('/api/stories', (req, res) => {
    // Define possible paths where the file might be located in the serverless environment
    const possiblePaths = [
        path.resolve('data', 'summary.json'),
        path.join(process.cwd(), 'data', 'summary.json'),
        path.join(__dirname, 'data', 'summary.json'),
        path.join(__dirname, '..', 'data', 'summary.json') // Common in bundled functions
    ];

    // Find the first path that actually exists
    const summaryFilePath = possiblePaths.find(p => fs.existsSync(p));

    if (!summaryFilePath) {
        console.error('Error: summary.json not found in any expected location.');
        console.error('Checked paths:', possiblePaths);
        return res.json({ business: {}, marketing: {}, ai: {} });
    }

    fs.readFile(summaryFilePath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading summary file:', err);
            return res.status(500).send('Error loading story data.');
        }
        res.setHeader('Content-Type', 'application/json');
        res.send(data);
    });
});

app.post('/api/share/preview', ensureAuthenticated, async (req, res) => {
    console.log('--- Received request for /api/share/preview ---');
    console.log('Request Body:', req.body);

    const { headline, fullContent, originalUrl, includeBlogName, includeBlogLink, imageSource, imageSize, originalImage, includeLogo } = req.body;

    try {
        const humanizedText = await humanizeForLinkedIn(headline, fullContent, originalUrl, includeBlogName, includeBlogLink);
        
        let imageUrlToPreview = originalImage;
        console.log(`Initial imageUrlToPreview: ${imageUrlToPreview}`);

        if (imageSource === 'ai') {
            console.log('Image source is AI. Generating AI image...');
            imageUrlToPreview = await generateAiImage(humanizedText, imageSize);
            console.log(`AI-generated image URL: ${imageUrlToPreview}`);
        }

        if (includeLogo) {
            console.log('includeLogo is true. Adding logo to image...');
            // Define possible paths for the logo in serverless environment
            const possibleLogoPaths = [
                path.resolve('public', 'logo', 'logo.png'),
                path.join(process.cwd(), 'public', 'logo', 'logo.png'),
                path.join(__dirname, 'public', 'logo', 'logo.png'),
                path.join(__dirname, '..', 'public', 'logo', 'logo.png')
            ];
            const resolvedLogoPath = possibleLogoPaths.find(p => fs.existsSync(p));

            if (resolvedLogoPath) {
                imageUrlToPreview = await addLogoToImage(imageUrlToPreview, resolvedLogoPath);
            } else {
                console.warn('Logo file not found. Skipping logo addition.');
            }
        } else {
            console.log('includeLogo is false. Skipping logo addition.');
        }

        if (imageUrlToPreview) {
            console.log(`Final previewImageUrl: ${imageUrlToPreview.substring(0, 100)}...`);
        }

        res.status(200).json({
            previewText: humanizedText,
            previewImageUrl: imageUrlToPreview
        });

    } catch (error) {
        console.error('Error generating preview:', error);
        res.status(500).json({ message: 'Failed to generate preview.' });
    }
});

app.post('/api/scrape', async (req, res) => {
    try {
        console.log('--- Manual scraper trigger received ---');
        await runScraper();
        console.log('--- Scraper finished successfully ---');
        res.status(200).json({ message: 'Scraping completed successfully.' });
    } catch (error) {
        console.error('Error running scraper:', error);
        res.status(500).json({ message: 'Failed to run scraper.', error: error.message });
    }
});

app.post('/api/share/post', ensureAuthenticated, async (req, res) => {
    const { content, imageUrl, originalUrl, headline, authorUrn } = req.body;
    const accessToken = req.user.accessToken;
    const personUrn = req.user.personUrn;

    try {
        const imageUrn = await uploadImageToLinkedIn(accessToken, personUrn.split(':').pop(), imageUrl);
        await createLinkedInPost(accessToken, personUrn, content, imageUrn, originalUrl, headline, authorUrn);
        res.status(200).json({ message: 'Successfully posted to LinkedIn!' });
    } catch (error) {
        console.error('Error sharing to LinkedIn:', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Failed to share on LinkedIn.' });
    }
});


// --- Image & Text Helper Functions ---

async function addLogoToImage(baseImageUrl, logoPath) {
    console.log('--- Entering addLogoToImage function ---');
    try {
        console.log(`Base image URL: ${baseImageUrl}`);
        const baseImageResponse = await axios.get(baseImageUrl, { responseType: 'arraybuffer' });
        const baseImageBuffer = Buffer.from(baseImageResponse.data, 'binary');
        console.log('Successfully downloaded base image and created buffer.');

        const logoBuffer = fs.readFileSync(logoPath);
        console.log('Successfully read logo file and created buffer.');

        const baseImage = sharp(baseImageBuffer);
        const metadata = await baseImage.metadata();

        const logoWidth = Math.floor(metadata.width * 0.15);
        console.log(`Resizing logo to width: ${logoWidth}`);
        const resizedLogoBuffer = await sharp(logoBuffer).resize(logoWidth).toBuffer();

        const margin = Math.floor(metadata.width * 0.02);
        console.log(`Compositing logo with margin: ${margin}`);
        const finalImageBuffer = await baseImage
            .composite([{
                input: resizedLogoBuffer,
                top: margin,
                left: margin
            }])
            .toBuffer();

        const finalImageURI = `data:image/png;base64,${finalImageBuffer.toString('base64')}`;
        console.log('--- Successfully composited logo. Returning base64 URI. ---');
        return finalImageURI;
    } catch (error) {
        console.error('Error in addLogoToImage:', error);
        return baseImageUrl; // Return original image if logo overlay fails
    }
}

async function humanizeForLinkedIn(headline, content, url, includeBlogName, includeBlogLink) {
    let userPrompt = `Headline: ${headline}\n\nContent: ${content.substring(0, 1500)}`;
    if (includeBlogName) {
        userPrompt += `\n\nSource: TechUp`; // Or your blog's name
    }
    if (includeBlogLink) {
        userPrompt += `\n\nOriginal Source: ${url}`;
    }

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{
                role: "system",
                content: "You are a social media manager creating an engaging LinkedIn post from a tech article. Create a compelling post with a strong hook, 2-3 key takeaways, and relevant hashtags. The tone should be insightful and professional.",
            }, { 
                role: "user",
                content: userPrompt,
            }],
        });
        return response.choices[0].message.content;
    } catch (error) {
        console.error('OpenAI API Error during humanization:', error);
        return `Error generating content. Please try again.`;
    }
}

async function generateAiImage(content, size) {
    console.log(`Generating AI image with size ${size}...`);
    try {
        const response = await openai.images.generate({
            model: "dall-e-3",
            prompt: `Create a visually appealing, professional, and abstract image suitable for a LinkedIn post. The image should be thematically related to the following content, but it must not contain any text, words, or letters. Content: ${content.substring(0, 1000)}`,
            n: 1,
            size: "1024x1024", // Hardcoded to a valid size
        });
        return response.data[0].url;
    } catch (error) {
        console.error('DALL-E API Error:', error);
        return `https://placehold.co/1024x1024/21262d/8b949e?text=Image+Gen+Failed`;
    }
}

// --- LinkedIn Sharing Helper Functions ---

async function uploadImageToLinkedIn(accessToken, linkedInId, imageUrl) {
    if (!imageUrl || imageUrl.includes('placehold.co')) {
        return null;
    }

    let imageBuffer;
    if (imageUrl.startsWith('data:image')) {
        imageBuffer = Buffer.from(imageUrl.split(',')[1], 'base64');
    } else {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        imageBuffer = Buffer.from(response.data, 'binary');
    }

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

    await axios.put(uploadUrl, imageBuffer, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'image/png'
        }
    });

    return imageUrn;
}

async function createLinkedInPost(accessToken, personUrn, text, imageUrn, originalUrl, headline, authorUrn) {
    const postBody = {
        "author": authorUrn || personUrn,
        "lifecycleState": "PUBLISHED",
        "specificContent": {
            "com.linkedin.ugc.ShareContent": {
                "shareCommentary": { "text": text },
                "shareMediaCategory": "NONE", 
                "media": []
            }
        },
        "visibility": {
            "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"
        }
    };

    // Add image or article link to the post
    if (imageUrn) {
        postBody.specificContent["com.linkedin.ugc.ShareContent"].shareMediaCategory = "IMAGE";
        postBody.specificContent["com.linkedin.ugc.ShareContent"].media.push({
            "status": "READY",
            "media": imageUrn
        });
    } else if (originalUrl) {
        postBody.specificContent["com.linkedin.ugc.ShareContent"].shareMediaCategory = "ARTICLE";
        postBody.specificContent["com.linkedin.ugc.ShareContent"].media.push({
            "status": "READY",
            "originalUrl": originalUrl,
            "title": { "text": headline }
        });
    }

    await axios.post('https://api.linkedin.com/v2/ugcPosts', postBody, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        }
    });
}

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
