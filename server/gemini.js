const axios = require('axios');

async function analyzeContentWithGemini(contextHtml, promptText) {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set in .env!");
    return "Error: GEMINI_API_KEY is missing.";
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;

  // We are stripping aggressive HTML payload length here so we don't blow up the context window
  // Just taking a substring of the text if it's exceedingly long.
  const contentToAnalyze = contextHtml.length > 25000 ? contextHtml.substring(0, 25000) + '... (truncated)' : contextHtml;

  try {
    const payload = {
      contents: [
        {
          parts: [
            { text: `You are an AI Web Scraper Analyzer. You will be provided with some webpage text, and a prompt of what the user wants to extract or analyze from it. \n\nUser's Prompt: ${promptText}\n\nWebpage Text:\n${contentToAnalyze}` }
          ]
        }
      ]
    };

    const response = await axios.post(endpoint, payload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.data && response.data.candidates && response.data.candidates.length > 0) {
      return response.data.candidates[0].content.parts[0].text;
    } else {
      return "No content returned from Gemini.";
    }
  } catch (error) {
    console.error("Gemini API Error:", error.response?.data || error.message);
    return `Error: ${error.message}`;
  }
}

module.exports = { analyzeContentWithGemini };
