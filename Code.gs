// Code.gs

function checkScholarAlerts() {
  var label = GmailApp.getUserLabelByName("PhD/research alerts"); // change according to your label
  if (!label) {
    Logger.log("Label 'PhD/research alerts' not found.");
    return;
  }

  var threads = [];
  var batch;
  var start = 0;
  do {
    batch = label.getThreads(start, 100);
    threads = threads.concat(batch);
    start += 100;
  } while (batch.length === 100);

  var sheetName = "Scholar Alerts";
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) {
    sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet(sheetName);
    sheet.appendRow([
      "Date received",
      "Title",
      "URL",
      "Abstract (from email)",
      "Main Methods",
      "Main Analyses"
    ]);
  }

  var processedUrls = new Set();
  var sheetValues = sheet.getRange("C2:C" + sheet.getLastRow()).getValues();
  for (var i = 0; i < sheetValues.length; i++) {
    if (sheetValues[i][0]) {
      processedUrls.add(sheetValues[i][0]);
    }
  }

  var newRows = [];
  var anyArticlesFound = false;

  threads.forEach(function(thread) {
    var messages = thread.getMessages();
    messages.forEach(function(message) {
      var bodyHtml = message.getBody();
      var date = message.getDate();

      var paperRegex = /<h3[^>]*>\s*(?:<span[^>]*>.*?<\/span>\s*)?<a\s+href="([^"]+)"[^>]*>(.*?)<\/a><\/h3>/gims;
      var abstractRegex = /<div class="gse_alrt_sni"[^>]*>([\s\S]*?)<\/div>/im;

      var match;
      var lastIndex = 0;
      while ((match = paperRegex.exec(bodyHtml)) !== null) {
        anyArticlesFound = true;
        var url = match[1];
        var title = match[2].replace(/<[^>]+>/g, '').trim();

        var abstractPreview = "";
        var afterTitle = bodyHtml.slice(paperRegex.lastIndex);
        var abstractMatch = abstractRegex.exec(afterTitle);
        if (abstractMatch) {
          abstractPreview = abstractMatch[1].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').trim();
        }

        if (url.indexOf('url=') !== -1) {
          var urlMatch = /url=([^&]+)/.exec(url);
          if (urlMatch) {
            url = decodeURIComponent(urlMatch[1]);
          }
        }

        if (!processedUrls.has(url)) {
          newRows.push([date, title, url, abstractPreview, "", ""]);
          processedUrls.add(url);
        }
        paperRegex.lastIndex += (abstractMatch ? abstractMatch.index + abstractMatch[0].length : 0);
      }
    });
    thread.moveToTrash();
  });

  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
    Logger.log("Added " + newRows.length + " new articles.");
  } else if (anyArticlesFound) {
    Logger.log("No new articles found (all were already in the sheet).");
  } else {
    Logger.log("No articles found in any messages.");
  }
}

// --- Gemini Summaries ---

function sendWeeklyNewsletter() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Scholar Alerts");
  var data = sheet.getDataRange().getValues();
  var now = new Date();
  var oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  var html = '<h2>Weekly Scholar Alerts</h2><table border=1 cellpadding=4 style="border-collapse:collapse;">' +
    '<tr>' +
    '<th>Date received</th>' +
    '<th>Title</th>' +
    '<th>URL</th>' +
    '<th style="width:350px;">Gemini abstract summary (≤100 words)</th>' +
    '<th>Main Methods</th>' +
    '<th>Main Analyses</th>' +
    '<th style="width:350px;">Gemini bullet-points summary</th>' +
    '</tr>';

  var found = false;

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var date = new Date(row[0]);
    if (date >= oneWeekAgo) {
      found = true;
      var title = row[1];
      var url = row[2];
      var abstract = row[3];
      // Gemini abstract summary (≤100 words)
      var geminiAbstract = getGeminiAbstractSummary(title, abstract);
      // Gemini bullet-points summary
      var geminiBulletsObj = getGeminiBulletPointsSmart(title, abstract);
      var methods = geminiBulletsObj.methods;
      var analyses = geminiBulletsObj.analyses;
      var bullets = geminiBulletsObj.bullets;

      html += "<tr>" +
        "<td>" + date.toLocaleDateString() + "</td>" +
        "<td>" + title + "</td>" +
        "<td><a href='" + url + "'>Link</a></td>" +
        '<td style="width:350px;">' + geminiAbstract + "</td>" +
        "<td>" + methods + "</td>" +
        "<td>" + analyses + "</td>" +
        '<td style="width:350px; white-space:pre-line;">' + bullets + "</td>" +
        "</tr>";
    }
  }
  html += "</table>";

  if (!found) {
    Logger.log("No new papers this week, not sending email.");
    return;
  }

  MailApp.sendEmail({
    to: Session.getActiveUser().getEmail(),
    subject: "Your Weekly Scholar Newsletter",
    htmlBody: html
  });
  Logger.log("Newsletter sent!");
}

// --- Gemini API helpers ---

function getGeminiAbstractSummary(title, abstract) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('Gemini API key not found in script properties.');
  }
  if (!abstract || abstract.length < 30) {
    return "No abstract available.";
  }
  var prompt =
    "Summarize the following scientific abstract in no more than 100 words. Only output the summary, no extra text.\n\n" +
    "Title: " + title + "\nAbstract: " + abstract;

  var apiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + apiKey;
  var payload = {
    contents: [
      {
        parts: [
          { text: prompt }
        ]
      }
    ]
  };

  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(apiUrl, options);
  var json = JSON.parse(response.getContentText());
  if (json && json.candidates && json.candidates.length > 0) {
    return json.candidates[0].content.parts[0].text.trim();
  } else {
    return "No summary available (API error or quota exceeded).";
  }
}

function getGeminiBulletPointsSmart(title, abstract) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('Gemini API key not found in script properties.');
  }
  if (!abstract || abstract.length < 30) {
    return { methods: "", analyses: "", bullets: "No summary available (no abstract)." };
  }
  var prompt =
    "Given the following scientific paper title and abstract, do the following:\n" +
    "1. List the main methods used (keywords, e.g., fMRI, EEG, DTI, etc).\n" +
    "2. List the main analyses performed (keywords, e.g., ISC, MEA, etc).\n" +
    "3. Summarize the main findings and methods in 5-8 very concise, short bullet points (each bullet point should be a single sentence or phrase, no more than 15 words). Do not include any extra text or explanation.\n\n" +
    "Return your answer in this format:\n" +
    "Main Methods: ...\n" +
    "Main Analyses: ...\n" +
    "Gemini bullet-points summary:\n- ...\n- ...\n- ...\n- ...\n- ...\n\n" +
    "Title: " + title + "\nAbstract: " + abstract;

  var apiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" + apiKey;
  var payload = {
    contents: [
      {
        parts: [
          { text: prompt }
        ]
      }
    ]
  };

  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(apiUrl, options);
  var json = JSON.parse(response.getContentText());
  if (json && json.candidates && json.candidates.length > 0) {
    return parseGeminiBulletsResponse(json.candidates[0].content.parts[0].text.trim());
  } else {
    return { methods: "", analyses: "", bullets: "No summary available (API error or quota exceeded)." };
  }
}

function parseGeminiBulletsResponse(response) {
  var methods = "";
  var analyses = "";
  var bullets = [];
  var methodsMatch = response.match(/Main Methods:\s*(.*)/i);
  if (methodsMatch) methods = methodsMatch[1].trim();
  var analysesMatch = response.match(/Main Analyses:\s*(.*)/i);
  if (analysesMatch) analyses = analysesMatch[1].trim();
  var bulletsMatch = response.match(/Gemini bullet-points summary:\s*([\s\S]*)/i);
  if (bulletsMatch) {
    var lines = bulletsMatch[1].split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s*-\s*/, '').trim();
      if (line) bullets.push('• ' + line);
    }
  }
  // Join all bullets into a single string with newlines
  var bulletsString = bullets.join('\n');
  return { methods: methods, analyses: analyses, bullets: bulletsString };
}
