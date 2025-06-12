const functions = require("firebase-functions");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Initialize Gemini API with your API key
const genAI = new GoogleGenerativeAI("AIzaSyAh23yRMYYkQ5-z3gn7XhBwxuZD6pw5h5k");

exports.generateQuestions = functions.https.onCall(async (data, context) => {
  
  const subject = data.subject;

  // Log para depuração
  console.log("Received subject:", data.subject);
 
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `
      Generate exactly 10 questions about math.
      Format each question clearly and concisely.
      Each question should be on a separate line.
      Do not include any numbering or additional text.
    `;

    const result = await model.generateContent(prompt);

    if (!result || !result.response) {
      throw new Error("Empty or invalid response from Gemini API");
    }

    const response = await result.response;
    const text = response.text();

    const questions = Array.from(new Set(
      text.split("\n").map(q => q.trim()).filter(q => q)
    ));

    // ✅ Corrigido: retorne como objeto com chave 'questions'
    return { questions: questions.slice(0, count) };

  } catch (error) {
    console.error("Gemini API Error:", error);
    throw new functions.https.HttpsError(
      "internal",
      "Failed to generate questions",
      error.message
    );
  }
});