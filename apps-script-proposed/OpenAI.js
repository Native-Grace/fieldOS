/**
 * OpenAI.gs
 * Direct integration gateway for Whisper (Audio) and GPT-4o (Chat).
 *
 * Whisper multipart: UrlFetchApp sends Blob parts using blob.getName() as the
 * filename and blob.getContentType() as the part Content-Type. Callers must
 * pass a normalised blob (see fieldosVpPrepareWhisperUploadBlob_).
 */

var OpenAI = {
  
  getApiKey: function() {
    return PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  },

  /**
   * Transcribes an audio blob using OpenAI Whisper API.
   * @param {GoogleAppsScript.Base.Blob} audioBlob must have valid filename + Content-Type
   * @returns {string}
   */
  transcribeAudio: function(audioBlob) {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error("OpenAI API key is missing from Script Properties.");

    if (!audioBlob || typeof audioBlob.getBytes !== "function") {
      throw new Error("OpenAI.transcribeAudio requires an audio Blob.");
    }

    const bytes = audioBlob.getBytes();
    const byteLength = bytes && bytes.length ? bytes.length : 0;
    const filename = String(audioBlob.getName() || "").trim();
    const contentType = String(audioBlob.getContentType() || "")
      .split(";")[0]
      .trim();

    if (byteLength === 0) {
      throw new Error(
        "OpenAI.transcribeAudio rejected zero-byte blob filename=" +
          (filename || "(none)") +
          " mime=" +
          (contentType || "(none)")
      );
    }
    if (!filename || !/\.[A-Za-z0-9]+$/.test(filename)) {
      throw new Error(
        "OpenAI.transcribeAudio requires a filename with extension; got filename=" +
          (filename || "(none)") +
          " mime=" +
          (contentType || "(none)") +
          " byte_length=" +
          byteLength
      );
    }
    if (!contentType) {
      throw new Error(
        "OpenAI.transcribeAudio requires Content-Type; got filename=" +
          filename +
          " byte_length=" +
          byteLength
      );
    }

    const url = "https://api.openai.com/v1/audio/transcriptions";

    // Multipart form: Blob part filename = getName(), Content-Type = getContentType().
    const payload = {
      file: audioBlob,
      model: "whisper-1",
      language: "en"
    };

    const options = {
      method: "post",
      headers: {
        "Authorization": "Bearer " + apiKey
      },
      payload: payload,
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const respCode = response.getResponseCode();
    const respText = response.getContentText();

    if (respCode !== 200) {
      throw new Error("Whisper API Error (" + respCode + "): " + respText);
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
      temperature: 0.1
    };

    const options = {
      method: "post",
      contentType: "application/json",
      headers: {
        "Authorization": "Bearer " + apiKey
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const respCode = response.getResponseCode();
    const respText = response.getContentText();

    if (respCode !== 200) {
      throw new Error("GPT API Error (" + respCode + "): " + respText);
    }

    const json = JSON.parse(respText);
    return json.choices[0].message.content;
  }
};
