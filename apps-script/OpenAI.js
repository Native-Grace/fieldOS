/**
 * OpenAI.gs
 * Direct integration gateway for Whisper (Audio) and GPT-4o (Chat).
 */

const OpenAI = {
  
  getApiKey: function() {
    return PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  },

  /**
   * Transcribes an audio blob using OpenAI Whisper API.
   */
  transcribeAudio: function(audioBlob) {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error("OpenAI API key is missing from Script Properties.");

    const url = "https://api.openai.com/v1/audio/transcriptions";
    
    const payload = {
      file: audioBlob,
      model: "whisper-1",
      language: "en"
    };

    const options = {
      method: "post",
      headers: {
        "Authorization": `Bearer ${apiKey}`
      },
      payload: payload,
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const respCode = response.getResponseCode();
    const respText = response.getContentText();

    if (respCode !== 200) {
      throw new Error(`Whisper API Error (${respCode}): ${respText}`);
    }

    const json = JSON.parse(respText);
    return json.text;
  },

  /**
   * Sends a prompt to GPT-4o using structured JSON response format.
   */
  chatComplete: function(systemPrompt, userPrompt) {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error("OpenAI API key is missing from Script Properties.");

    const url = "https://api.openai.com/v1/chat/completions";

    const payload = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1 // Low temperature ensures strict adherence to structural schema mapping
    };

    const options = {
      method: "post",
      contentType: "application/json",
      headers: {
        "Authorization": `Bearer ${apiKey}`
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const respCode = response.getResponseCode();
    const respText = response.getContentText();

    if (respCode !== 200) {
      throw new Error(`GPT API Error (${respCode}): ${respText}`);
    }

    const json = JSON.parse(respText);
    return json.choices[0].message.content;
  }
};