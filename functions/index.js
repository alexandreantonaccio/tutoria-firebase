const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2/options");
const logger = require("firebase-functions/logger");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const admin = require('firebase-admin');
const { defineSecret } = require("firebase-functions/params");
const { FieldValue } = require('firebase-admin/firestore');

admin.initializeApp();
const db = admin.firestore();

// Configurações globais
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// 1. Definição do Segredo
const apiKey = defineSecret("API_KEY");

// --- FUNÇÕES AUXILIARES ---

// Helper para instanciar o cliente dentro das funções
const getGenAI = () => {
    return new GoogleGenerativeAI(apiKey.value());
};

const createPrompt = (count, subject) => `
  Você é um especialista em criação de questões de múltipla escolha para estudantes de vestibular. 
  Sua tarefa é gerar ${count} questões de alta qualidade que se assemelhem ao formato de provas de vestibular (Como: ENEM, textos longos, 
  explicando a situação para poder começar a introduzir a problemática da questão),
  com 5 alternativas (A, B, C, D, E) e uma única resposta correta.

  As questões devem ser rigorosas, mas compreensíveis, e testar o conhecimento do estudante de forma eficaz.
  A matéria das questões é: ${subject}.
    
  Sua resposta DEVE ser um array JSON válido de objetos.
  
  Cada objeto no array DEVE ter esta estrutura exata:
  {
    "enunciado": "O texto da questão...",
    "alternativas": ["A) ...", "B) ...", "C) ...", "D) ...", "E) ..."],
    "alternativaCorreta": "A",
    "materia": "${subject}",
    "assunto": "Tópico específico da questão",
    "nivel": "fácil" 
  }

  É CRÍTICO que você retorne EXATAMENTE ${count} questões no array JSON.`;

const parseLLMResponse = (rawText) => {
    try {
        // Tenta fazer o parse direto (graças ao JSON mode do Gemini)
        return JSON.parse(rawText);
    } catch (e) {
        // Fallback: Se a IA ainda colocar markdown (```json ... ```), limpamos manualmente
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
    }
};

// --- CLOUD FUNCTIONS ---

exports.generateQuestions = onCall(
    { secrets: [apiKey] }, // CORREÇÃO: Segredo declarado aqui
    async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'The function must be called by an authenticated user.');
    }
    
    const userId = request.auth.uid;
    const { subject, count } = request.data;

    if (!subject || !count) {
        throw new HttpsError('invalid-argument', 'The "subject" and "count" parameters are required.');
    }

    try {
        const genAI = getGenAI(); // CORREÇÃO: Inicializado dentro da função
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.0-flash",
            generationConfig: {
                maxOutputTokens: 8192,
                temperature: 0.2,
                responseMimeType: "application/json" // CORREÇÃO: Força resposta JSON
            }
        });
        
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

exports.generateSimulado = onCall(
    { secrets: [apiKey], timeoutSeconds: 300 }, // CORREÇÃO: Segredo declarado aqui
    async (request) => { 
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'The function must be called by an authenticated user.');
    }
    const userId = request.auth.uid;
    const { area, foreignLanguage } = request.data;

    if (!area) {
        throw new HttpsError('invalid-argument', 'The "area" parameter is required.');
    }

    const genAI = getGenAI(); // CORREÇÃO: Inicializado dentro da função
    // Usamos JSON mode para garantir integridade ao juntar várias respostas
    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.0-flash",
        generationConfig: { responseMimeType: "application/json" } 
    });

    let generationPromises;
    let finalExamName = area;
    let isNivelamento = false;

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
            const qs = parseLLMResponse(result.response.text());
            if (Array.isArray(qs)) {
                allQuestions.push(...qs);
            }
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

exports.generateExplanation = onCall(
    { secrets: [apiKey] }, // CORREÇÃO: Segredo declarado aqui
    async (request) => {
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
        const genAI = getGenAI(); // CORREÇÃO
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent(prompt);
        return { explanation: result.response.text() };
    } catch (error) {
        logger.error("Error in generateExplanation:", error);
        throw new HttpsError("internal", "Failed to generate explanation.");
    }
});

exports.generateStudyPlan = onCall(
    { secrets: [apiKey] }, // CORREÇÃO: Segredo declarado aqui
    async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'The function must be called by an authenticated user.');
    }

    const { incorrectQuestions } = request.data;
    
    // Validação básica
    if (!incorrectQuestions || !Array.isArray(incorrectQuestions)) {
        throw new HttpsError('invalid-argument', 'Invalid questions data.');
    }

    // Limitamos a quantidade de contexto para não estourar tokens e economizar
    const topicSummary = incorrectQuestions.slice(0, 20).map(q => `- Matéria: ${q.materia}, Assunto: ${q.assunto}`).join('\n');

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
        const genAI = getGenAI(); // CORREÇÃO
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const result = await model.generateContent(prompt);
        return { plan: result.response.text() };
    } catch (error) {
        logger.error("Error in generateStudyPlan:", error);
        throw new HttpsError("internal", "Failed to generate study plan.");
    }
});