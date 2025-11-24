// Importações da Geração 2 (v2)
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2/options");
const logger = require("firebase-functions/logger");

const { GoogleGenerativeAI } = require("@google/generative-ai");
const admin = require('firebase-admin');

// Inicializar Firebase Admin
admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = require('firebase-admin/firestore');

// Configurações Globais para as funções v2
// Define a região padrão e o limite máximo de instâncias para evitar custos excessivos
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// **INSTRUÇÃO IMPORTANTE PARA DEPLOY**
// Para produção, considere usar o Secret Manager do Cloud Functions v2:
// const { defineSecret } = require('firebase-functions/params');
// const apiKey = defineSecret('GEMINI_API_KEY');
// E adicionar { secrets: [apiKey] } nas opções da função.

const geminiApiKey = "AIzaSyD8o2MTltzkSFjwBbNDF8vD3o8HrzG9ySM"; 
const genAI = new GoogleGenerativeAI(geminiApiKey);

const createPrompt = (count, subject) => `
  Você é um especialista em criação de questões de múltipla escolha para estudantes de vestibular. 
  Sua tarefa é gerar ${count} questões de alta qualidade que se assemelhem ao formato de provas de vestibular (Como: ENEM, textos longos, 
  explicando a situação para poder começar a introduzir a problemática da questão),
  com 5 alternativas (A, B, C, D, E) e uma única resposta correta.

  As questões devem ser rigorosas, mas compreensíveis, e testar o conhecimento do estudante de forma eficaz.
  A matéria das questões é: ${subject}.
    
  Sua resposta DEVE ser um array JSON válido de objetos, e NADA MAIS, não inclua texto de auxilio, APENAS o array JSON valido.
  NÃO inclua markdown (como \`\`\`json) ou qualquer texto antes ou depois do array.
  
  Cada objeto no array DEVE ter esta estrutura exata:
  {
    "enunciado": "O texto da questão...",
    "alternativas": ["A) ...", "B) ...", "C) ...", "D) ...", "E) ..."],
    "alternativaCorreta": "A",
    "materia": "${subject}",
    "assunto": "Tópico específico da questão",
    "nivel": "fácil" 
  }

  É CRÍTICO que você retorne EXATAMENTE ${count} questões no array JSON. A resposta deve começar com '[' e terminar com ']'.`;

const parseLLMResponse = (rawText) => {
    try {
        const startIndex = rawText.indexOf('[');
        const endIndex = rawText.lastIndexOf(']');

        if (startIndex === -1 || endIndex === -1) {
            throw new Error("JSON array not found in the response.");
        }

        const jsonString = rawText.substring(startIndex, endIndex + 1);
        const questions = JSON.parse(jsonString);
        
        if (!Array.isArray(questions)) {
            throw new Error("AI response is not a valid JSON array.");
        }
        return questions;
    } catch (parseError) {
        logger.error("Error parsing JSON:", parseError);
        logger.error("Received text for parsing:", rawText);
        throw new HttpsError("internal", "Invalid response format from the AI.");
    }
};

// --- FUNÇÕES MIGRADAS PARA V2 ---

// Na v2, usamos `onCall` diretamente. O argumento muda de `(data, context)` para `(request)`.
// `request.data` contém os dados enviados pelo cliente.
// `request.auth` contém as informações de autenticação.

exports.generateQuestions = onCall(async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'The function must be called by an authenticated user.');
    }
    
    const userId = request.auth.uid;
    const { subject, count } = request.data;

    if (!subject || !count) {
        throw new HttpsError('invalid-argument', 'The "subject" and "count" parameters are required.');
    }

    try {
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.0-flash",
            generationConfig: {
                "maxOutputTokens": 8192,
                "temperature": 0.2,
            }
        });
        
        constHV_prompt = createPrompt(count, subject);

        const result = await model.generateContent(createPrompt(count, subject));
        const questions = parseLLMResponse(result.response.text());
        
        const validatedQuestions = questions.slice(0, count);

        const provaData = {
            materia: subject,
            questoes: validatedQuestions,
            totalQuestoes: validatedQuestions.length,
            criadaEm: FieldValue.serverTimestamp(),
            status: 'ativa',
            respostaUsuario: [],
            pontuacao: 0,
            finalizadaEm: null
        };

        const provaRef = await db.collection('users').doc(userId).collection('provas').add(provaData);
        
        return { questions: validatedQuestions, provaId: provaRef.id };

    } catch (error) {
        logger.error("Error in generateQuestions:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Failed to generate questions.");
    }
});

exports.generateSimulado = onCall({ timeoutSeconds: 300 }, async (request) => { // Aumentado timeout para simulados
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'The function must be called by an authenticated user.');
    }
    const userId = request.auth.uid;
    const { area, foreignLanguage } = request.data;

    if (!area) {
        throw new HttpsError('invalid-argument', 'The "area" parameter is required.');
    }

    let generationPromises;
    let finalExamName = area;
    let isNivelamento = false;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    switch (area) {
        case 'Conhecimentos Gerais':
            isNivelamento = true;
            finalExamName = 'Nivelamento - Conhecimentos Gerais';
            generationPromises = [
                model.generateContent(createPrompt(4, 'Ciências Humanas (Misto)')),
                model.generateContent(createPrompt(4, 'Ciências da Natureza (Misto)')),
                model.generateContent(createPrompt(4, 'Matemática (Básica)')),
                model.generateContent(createPrompt(3, 'Português (Interpretação)'))
            ];
            break;
        case 'Ciências da Natureza':
            generationPromises = ['Física', 'Química', 'Biologia'].map(topic => model.generateContent(createPrompt(15, topic)));
            break;
        case 'Ciências Humanas':
            generationPromises = ['História', 'Geografia', 'Sociologia e Filosofia'].map(topic => model.generateContent(createPrompt(15, topic)));
            break;
        case 'Matemática':
            generationPromises = ['Matemática', 'Matemática', 'Matemática'].map(topic => model.generateContent(createPrompt(15, topic)));
            break;
        case 'Linguagens e Códigos':
            if (!foreignLanguage || (foreignLanguage !== 'Inglês' && foreignLanguage !== 'Espanhol')) {
                throw new HttpsError('invalid-argument', 'For the Languages area, the foreign language is required.');
            }
            finalExamName = `Linguagens (${foreignLanguage})`;
            generationPromises = [
                model.generateContent(createPrompt(5, foreignLanguage)),
                model.generateContent(createPrompt(20, 'Português (Interpretação de Texto e Gramática)')),
                model.generateContent(createPrompt(20, 'Literatura Brasileira e Artes'))
            ];
            break;
        default:
            throw new HttpsError('invalid-argument', 'Invalid knowledge area.');
    }

    try {
        const results = await Promise.all(generationPromises);

        let allQuestions = [];
        results.forEach(result => {
            allQuestions.push(...parseLLMResponse(result.response.text()));
        });
        
        const expectedCount = isNivelamento ? 15 : 45;
        if (allQuestions.length !== expectedCount) {
             logger.warn(`Expected ${expectedCount} questions, but got ${allQuestions.length}.`);
        }

        const provaData = {
            materia: finalExamName,
            questoes: allQuestions,
            totalQuestoes: allQuestions.length,
            criadaEm: FieldValue.serverTimestamp(),
            status: 'ativa',
            respostaUsuario: [],
            pontuacao: 0,
            finalizadaEm: null
        };

        const provaRef = await db.collection('users').doc(userId).collection('provas').add(provaData);

        return { questions: allQuestions, provaId: provaRef.id };

    } catch (error) {
        logger.error("Error in generateSimulado:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("internal", "Failed to generate the simulation.");
    }
});

exports.generateExplanation = onCall(async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'The function must be called by an authenticated user.');
    }

    const { question, userAnswer, correctAnswerText } = request.data;

    if (!question || !userAnswer || !correctAnswerText) {
        throw new HttpsError('invalid-argument', 'Missing required parameters.');
    }

    const prompt = `
      Você é um tutor especialista em vestibular. Um aluno respondeu a uma questão e errou. Sua tarefa é fornecer uma explicação clara e pedagógica.
      **Questão:**
      - **Enunciado:** ${question.enunciado}
      - **Matéria:** ${question.materia}
      - **Assunto:** ${question.assunto}
      **Respostas:**
      - **Alternativa Correta:** ${correctAnswerText}
      - **Alternativa que o aluno marcou:** ${userAnswer}
      **Instruções:**
      1. Explique por que a alternativa correta está certa.
      2. Explique por que a alternativa do aluno está errada.
      3. Conclua com uma dica de estudo.
      Retorne a resposta em texto simples, bem estruturado.
    `;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent(prompt);
        return { explanation: result.response.text() };
    } catch (error) {
        logger.error("Error in generateExplanation:", error);
        throw new HttpsError("internal", "Failed to generate explanation.");
    }
});

exports.generateStudyPlan = onCall(async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'The function must be called by an authenticated user.');
    }

    const { incorrectQuestions } = request.data;

    const topicSummary = incorrectQuestions.map(q => `- Matéria: ${q.materia}, Assunto: ${q.assunto}`).join('\n');

    const prompt = `
      Você é um orientador de estudos especialista em preparação para o ENEM. Um aluno errou as seguintes questões:
      **Resumo dos erros:**
      ${topicSummary}
      **Tarefa:**
      Crie um plano de estudos conciso e prático, focado em reforçar os pontos fracos.
      **Estrutura do Plano:**
      - **Diagnóstico:** Breve análise dos pontos a melhorar.
      - **Tópicos Prioritários:** Liste os 3 principais assuntos/matérias para focar.
      - **Sugestões de Estudo:** Para cada tópico, dê 2-3 sugestões práticas.
      - **Mensagem Final:** Termine com uma frase de incentivo.
      Retorne o plano em Markdown (## para títulos, * para listas).
    `;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent(prompt);
        return { plan: result.response.text() };
    } catch (error) {
        logger.error("Error in generateStudyPlan:", error);
        throw new HttpsError("internal", "Failed to generate study plan.");
    }
});