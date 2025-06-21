const functions = require("firebase-functions");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cors = require('cors')({ origin: true }); // Adicione esta linha

// Initialize Gemini API with your API key
const genAI = new GoogleGenerativeAI('AIzaSyAh23yRMYYkQ5-z3gn7XhBwxuZD6pw5h5k');

// Versão 1: Usando CORS middleware (Recomendado)
exports.generateQuestions = functions.https.onRequest((req, res) => {
  return cors(req, res, async () => {
    // Verificar se é uma requisição POST (Firebase Callable functions usam POST)
    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
    }

    try {
      // Para callable functions, os dados vêm em req.body.data
      const { subject, count } = req.body.data.data;

      // Log para depuração
      console.log("Received count:", count);
      console.log("Received subject:", subject);
 
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

      const prompt = `
        Você é um especialista em criação de questões de múltipla escolha para estudantes de vestibular. 
        Sua tarefa é gerar ${count} questões de alta qualidade que se assemelhem ao formato de provas de vestibular (Como: ENEM, textos longos, 
        explicando a situação para poder começar a introduzir a problemática da questão),
         com 5 alternativas (A, B, C, D, E) e uma única resposta correta.\n\nAs questões devem ser rigorosas, 
         mas compreensíveis, e testar o conhecimento do estudante de forma eficaz.
         \n\nSua resposta DEVE ser um array JSON de objetos, onde cada objeto representa uma questão. 
         Cada questão DEVE ter as seguintes propriedades:\n- enunciado: O texto completo da questão.
         \n- alternativas: Um array de 5 strings, onde cada string é o texto de uma alternativa.
         \n- alternativaCorreta: A letra da alternativa correta (ex: \"A\", \"B\", \"C\", \"D\", \"E\").\n- 
         materia: A matéria à qual a questão pertence ${subject} (ex: \"Física\", \"Química\", \"Biologia\", \"Português\", \"História\", \"Geografia\").\n- 
         assunto: O tópico específico da matéria (ex: \"Cinemática\", \"Reações orgânicas\", \"Ecologia\").\n- nivel: O nível de dificuldade da questão (\"fácil\", \"médio\", \"difícil\").\n\n
         Exemplo de formato de saída esperado para UMA questão:\n{\n  \"enunciado\": \"Qual a principal diferença entre um processo exotérmico e um endotérmico?\",\n  \"alternativas\": [\n    \"Processos exotérmicos liberam calor, enquanto endotérmicos absorvem.\",\n    \"Processos exotérmicos absorvem calor, enquanto endotérmicos liberam.\",\n    \"Ambos os processos não envolvem troca de calor.\",\n    \"Processos exotérmicos aumentam a entropia, e endotérmicos diminuem.\",\n    \"Processos exotérmicos são espontâneos, e endotérmicos não.\"\n  ],\n  \"alternativaCorreta\": \"A\",\n  \"materia\": \"Química\",\n  \"assunto\": \"Termodinâmica\",\n  \"nivel\": \"médio\"\n}
        `;

      const result = await model.generateContent(prompt);

      if (!result || !result.response) {
        throw new Error("Resposta invalida da llm");
      }

      const response = await result.response;
      const rawText = response.text();

      // Divide as questões por duas quebras de linha (assumindo separação por linha em branco)
      const questions = rawText
        .split(/\n\s*\n/)  // separa por linhas em branco
        .map(q => q.trim()) // remove espaços antes/depois
        .filter(q => q); // remove entradas vazias

      // Retornar no formato esperado pelo Firebase Callable
      res.status(200).json({
        data: {
          questions: questions.slice(0, count)
        }
      });

    } catch (error) {
      console.error("Gemini API Error:", error);
      res.status(500).json({
        error: {
          message: "Failed to generate questions",
          details: error.message
        }
      });
    }
  });
});

// Versão 2: Usando onCall com configuração de CORS manual (Alternativa)
exports.generateQuestionsV2 = functions.https.onCall(async (data, context) => {
  const { subject, count } = data.data;

  // Log para depuração
  console.log("Received count:", count);
  console.log("Received subject:", subject);
 
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const prompt = `
      Você é um especialista em criação de questões de múltipla escolha para estudantes de vestibular. 
      Sua tarefa é gerar ${count} questões de alta qualidade que se assemelhem ao formato de provas de vestibular (Como: ENEM, textos longos, 
      explicando a situação para poder começar a introduzir a problemática da questão),
       com 5 alternativas (A, B, C, D, E) e uma única resposta correta.\n\nAs questões devem ser rigorosas, 
       mas compreensíveis, e testar o conhecimento do estudante de forma eficaz.
       \n\nSua resposta DEVE ser um array JSON de objetos, onde cada objeto representa uma questão. 
       Cada questão DEVE ter as seguintes propriedades:\n- enunciado: O texto completo da questão.
       \n- alternativas: Um array de 5 strings, onde cada string é o texto de uma alternativa.
       \n- alternativaCorreta: A letra da alternativa correta (ex: \"A\", \"B\", \"C\", \"D\", \"E\").\n- 
       materia: A matéria à qual a questão pertence ${subject} .\n- 
       assunto: O tópico específico da matéria (ex: \"Cinemática\", \"Reações orgânicas\", \"Ecologia\").\n- nivel: O nível de dificuldade da questão (\"fácil\", \"médio\", \"difícil\").\n\n
       Exemplo de formato de saída esperado para UMA questão:\n{\n  \"enunciado\": \"Qual a principal diferença entre um processo exotérmico e um endotérmico?\",\n  \"alternativas\": [\n    \"Processos exotérmicos liberam calor, enquanto endotérmicos absorvem.\",\n    \"Processos exotérmicos absorvem calor, enquanto endotérmicos liberam.\",\n    \"Ambos os processos não envolvem troca de calor.\",\n    \"Processos exotérmicos aumentam a entropia, e endotérmicos diminuem.\",\n    \"Processos exotérmicos são espontâneos, e endotérmicos não.\"\n  ],\n  \"alternativaCorreta\": \"A\",\n  \"materia\": \"Química\",\n  \"assunto\": \"Termodinâmica\",\n  \"nivel\": \"médio\"\n}
      `;

    const result = await model.generateContent(prompt);

    if (!result || !result.response) {
      throw new Error("Resposta invalida da llm");
    }

    const response = await result.response;
    const rawText = response.text();

    // Divide as questões por duas quebras de linha (assumindo separação por linha em branco)
    const questions = rawText
      .split(/\n\s*\n/)  // separa por linhas em branco
      .map(q => q.trim()) // remove espaços antes/depois
      .filter(q => q); // remove entradas vazias

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