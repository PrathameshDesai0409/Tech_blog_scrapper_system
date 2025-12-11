const axios = require('axios');

exports.handler = async function(event, context) {
  const buildHookUrl = process.env.BUILD_HOOK_URL;

  if (!buildHookUrl) {
    console.error('Build hook URL is not defined.');
    return { statusCode: 500, body: 'Build hook URL not set.' };
  }

  try {
    console.log('Triggering a new build...');
    await axios.post(buildHookUrl);
    return { statusCode: 200, body: 'Build triggered successfully.' };
  } catch (error) {
    console.error('Error triggering build:', error.message);
    return { statusCode: 500, body: 'Failed to trigger build.' };
  }
};