const functions = require("firebase-functions");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const admin = require('firebase-admin');

// Inicializar Firebase Admin
admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = require('firebase-admin/firestore');

// **INSTRUÇÃO IMPORTANTE PARA DEPLOY**
// Atingir o limite da API é normal no plano gratuito. Para produção, você DEVE:
// 1. Habilitar o faturamento (Billing) no seu projeto Google Cloud.
// 2. Obter uma nova chave de API no Google AI Studio.
// 3. Salvar a chave de forma segura no ambiente do Firebase com o comando:
//    firebase functions:config:set gemini.key="SUA_NOVA_CHAVE_DE_API"
const geminiApiKey = "AIzaSyD8o2MTltzkSFjwBbNDF8vD3o8HrzG9ySM"; // Carregando a chave de forma segura
const genAI = new GoogleGenerativeAI(geminiApiKey);


const createPrompt = (count, subject) => `
  Você é um especialista em criação de questões de múltipla escolha para estudantes de vestibular. 
  Sua tarefa é gerar ${count} questões de alta qualidade que se assemelhem ao formato de provas de vestibular (Como: ENEM, textos longos, 
  explicando a situação para poder começar a introduzir a problemática da questão),
  com 5 alternativas (A, B, C, D, E) e uma única resposta correta.

  As questões devem ser rigorosas, mas compreensíveis, e testar o conhecimento do estudante de forma eficaz.
  A matéria das questões é: ${subject}.
    
  Sua resposta DEVE ser um array JSON válido de objetos. Cada objeto DEVE ter exatamente estas propriedades:
  - enunciado: O texto completo da questão
  - alternativas: Um array de exatamente 5 strings, cada uma começando com sua respectiva letra (Ex: "A) ...", "B) ...")
  - alternativaCorreta: A letra da alternativa correta ("A", "B", "C", "D" ou "E")
  - materia: A matéria "${subject}"
  - assunto: O tópico específico da matéria
  - nivel: O nível de dificuldade ("fácil", "médio" ou "difícil")

  IMPORTANTE: É CRÍTICO que você retorne EXATAMENTE ${count} questões no array JSON. A resposta deve conter apenas o array, sem nenhum outro texto.`;

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
        functions.logger.error("Error parsing JSON:", parseError);
        functions.logger.error("Received text for parsing:", rawText);
        throw new functions.https.HttpsError("internal", "Invalid response format from the AI.");
    }
};

// V1: A função `onCall` está em `functions.https.onCall`
// V1: O handler recebe `(data, context)` em vez de `(request)`
exports.generateQuestions = functions.https.onCall(async (data, context) => {
    // V1: A autenticação está em `context.auth`
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called by an authenticated user.');
    }
    const userId = context.auth.uid;
    // V1: Os dados da requisição estão diretamente no objeto `data`
    const { subject, count } = data;

    if (!subject || !count) {
        throw new functions.https.HttpsError('invalid-argument', 'The "subject" and "count" parameters are required.');
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const prompt = createPrompt(count, subject);

        const result = await model.generateContent(prompt);
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
        functions.logger.error("Error in generateQuestions:", error);
        if (error instanceof functions.https.HttpsError) throw error;
        throw new functions.https.HttpsError("internal", "Failed to generate questions.");
    }
});

exports.generateSimulado = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called by an authenticated user.');
    }
    const userId = context.auth.uid;
    const { area, foreignLanguage } = data;

    if (!area) {
        throw new functions.https.HttpsError('invalid-argument', 'The "area" parameter is required.');
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
                throw new functions.https.HttpsError('invalid-argument', 'For the Languages area, the foreign language is required.');
            }
            finalExamName = `Linguagens (${foreignLanguage})`;
            generationPromises = [
                model.generateContent(createPrompt(5, foreignLanguage)),
                model.generateContent(createPrompt(20, 'Português (Interpretação de Texto e Gramática)')),
                model.generateContent(createPrompt(20, 'Literatura Brasileira e Artes'))
            ];
            break;
        default:
            throw new functions.https.HttpsError('invalid-argument', 'Invalid knowledge area.');
    }

    try {
        const results = await Promise.all(generationPromises);

        let allQuestions = [];
        results.forEach(result => {
            allQuestions.push(...parseLLMResponse(result.response.text()));
        });
        
        const expectedCount = isNivelamento ? 15 : 45;
        if (allQuestions.length !== expectedCount) {
             functions.logger.warn(`Expected ${expectedCount} questions, but got ${allQuestions.length}.`);
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
        functions.logger.error("Error in generateSimulado:", error);
        if (error instanceof functions.https.HttpsError) throw error;
        throw new functions.https.HttpsError("internal", "Failed to generate the simulation.");
    }
});

exports.generateExplanation = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called by an authenticated user.');
    }

    const { question, userAnswer, correctAnswerText } = data;

    if (!question || !userAnswer || !correctAnswerText) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing required parameters.');
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
        functions.logger.error("Error in generateExplanation:", error);
        throw new functions.https.HttpsError("internal", "Failed to generate explanation.");
    }
});

exports.generateStudyPlan = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called by an authenticated user.');
    }

    const { incorrectQuestions } = data;

    if (!incorrectQuestions || incorrectQuestions.length === 0) {
        return { plan: "Parabéns! Você acertou todas as questões. Continue assim!" };
    }

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
        functions.logger.error("Error in generateStudyPlan:", error);
        throw new functions.https.HttpsError("internal", "Failed to generate study plan.");
    }
});