const functions = require("firebase-functions");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const admin = require('firebase-admin');
const cors = require('cors')({ origin: true });
// Initialize Firebase Admin
admin.initializeApp();
const db = admin.firestore();

const { FieldValue } = require('firebase-admin/firestore');
// Initialize Gemini API with your API key
const genAI = new GoogleGenerativeAI('AIzaSyAh23yRMYYkQ5-z3gn7XhBwxuZD6pw5h5k');

// Versão 1: Usando CORS middleware (Recomendado)
exports.generateQuestions = functions.https.onRequest((req, res) => {
  return cors(req, res, async () => {
    // Verificar se é uma requisição POST
    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
    }

    try {
      // Para callable functions, os dados vêm em req.body.data
      const { subject, count } = req.body.data;
      
      // Verificar autenticação
      const token = req.headers.authorization?.split('Bearer ')[1];
      if (!token) {
        return res.status(401).json({ error: 'Token de autenticação necessário' });
      }

      const decodedToken = await admin.auth().verifyIdToken(token);
      const userId = decodedToken.uid;

      // Log para depuração
      console.log("Received count:", count);
      console.log("Received subject:", subject);
      console.log("User ID:", userId);
 
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

      const prompt = `
        Você é um especialista em criação de questões de múltipla escolha para estudantes de vestibular. 
        Sua tarefa é gerar ${count} questões de alta qualidade que se assemelhem ao formato de provas de vestibular (Como: ENEM, textos longos, 
        explicando a situação para poder começar a introduzir a problemática da questão),
         com 5 alternativas (A, B, C, D, E) e uma única resposta correta.

        As questões devem ser rigorosas, mas compreensíveis, e testar o conhecimento do estudante de forma eficaz.
         
        Sua resposta DEVE ser um array JSON válido de objetos. Cada objeto DEVE ter exatamente estas propriedades:
        - enunciado: O texto completo da questão
        - alternativas: Um array de exatamente 5 strings (as opções A, B, C, D, E)
        - alternativaCorreta: A letra da alternativa correta ("A", "B", "C", "D" ou "E")
        - materia: A matéria "${subject}"
        - assunto: O tópico específico da matéria
        - nivel: O nível de dificuldade ("fácil", "médio" ou "difícil")

        IMPORTANTE: Retorne APENAS o array JSON, sem texto adicional antes ou depois.
        
        Exemplo de formato esperado:
        [
          {
            "enunciado": "Em um experimento de cinemática, um objeto é lançado verticalmente para cima com velocidade inicial de 20 m/s. Considerando g = 10 m/s², qual será a altura máxima atingida pelo objeto?",
            "alternativas": [
              "10 metros",
              "15 metros", 
              "20 metros",
              "25 metros",
              "30 metros"
            ],
            "alternativaCorreta": "C",
            "materia": "Física",
            "assunto": "Cinemática",
            "nivel": "médio"
          }
        ]
      `;

      const result = await model.generateContent(prompt);

      if (!result || !result.response) {
        throw new Error("Resposta inválida da LLM");
      }

      const response = await result.response;
      const rawText = response.text();
      
      // Limpar o texto e tentar fazer parse do JSON
      let questions;
      try {
        // Remove possíveis caracteres extras antes e depois do JSON
        const cleanedText = rawText.replace(/```json\n?|\n?```/g, '').trim();
        questions = JSON.parse(cleanedText);
        
        if (!Array.isArray(questions)) {
          throw new Error("Resposta não é um array");
        }
      } catch (parseError) {
        console.error("Erro ao fazer parse do JSON:", parseError);
        console.error("Texto recebido:", rawText);
        throw new Error("Formato de resposta inválido da IA");
      }

      // Validar estrutura das questões
      const validatedQuestions = questions.slice(0, count).map((q, index) => {
        if (!q.enunciado || !Array.isArray(q.alternativas) || q.alternativas.length !== 5 || !q.alternativaCorreta) {
          throw new Error(`Questão ${index + 1} tem formato inválido`);
        }
        return {
          enunciado: q.enunciado,
          alternativas: q.alternativas,
          alternativaCorreta: q.alternativaCorreta,
          materia: q.materia || subject,
          assunto: q.assunto || "Geral",
          nivel: q.nivel || "médio"
        };
      });

      // MUDANÇA: Salvar como subcoleção do usuário
      const provaData = {
        materia: subject,
        questoes: validatedQuestions,
        totalQuestoes: validatedQuestions.length,
        criadaEm: FieldValue.serverTimestamp(),
        status: 'ativa',
        respostaUsuario: [],
        pontuacao: 0,
        finalizadaem: null
      };

      // Salvar na subcoleção provas do usuário
      const provaRef = await db.collection('users').doc(userId).collection('provas').add(provaData);
      console.log("Prova salva com ID:", provaRef.id, "para usuário:", userId);

      // Retornar no formato esperado pelo Firebase Callable
      res.status(200).json({
        data: {
          questions: validatedQuestions,
          provaId: provaRef.id
        }
      });

    } catch (error) {
      console.error("Erro completo:", error);
      res.status(500).json({
        error: {
          message: "Falha ao gerar questões",
          details: error.message
        }
      });
    }
  });
});
exports.getProvaDetails = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Usuário deve estar autenticado');
  }

  const userId = context.auth.uid;
  const { provaId } = data;

  try {
    const provaDoc = await db.collection('users').doc(userId).collection('provas').doc(provaId).get();
    
    if (!provaDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'Prova não encontrada');
    }

    return provaDoc.data();
  } catch (error) {
    throw new functions.https.HttpsError('internal', 'Erro ao buscar prova', error);
  }
});

exports.updateProva = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Usuário deve estar autenticado');
    }

    const userId = context.auth.uid;
    const { provaId, respostasUsuario } = data;

    try {
        // Buscar prova
        const provaRef = db.collection('users').doc(userId).collection('provas').doc(provaId);
        const provaDoc = await provaRef.get();
        
        if (!provaDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Prova não encontrada');
        }
        
        const prova = provaDoc.data();
        
        // Verificar se a prova já foi finalizada
        if (prova.status === 'finalizada') {
            throw new functions.https.HttpsError('failed-precondition', 'Prova já finalizada não pode ser alterada');
        }
        
        // Calcular pontuação
        let pontuacao = 0;
        prova.questoes.forEach((q, index) => {
            if (respostasUsuario[index] === q.alternativaCorreta) {
                pontuacao++;
            }
        });
        
        // Atualizar prova
        await provaRef.update({
            respostasUsuario,
            pontuacao,
            finalizadaEm: FieldValue.serverTimestamp(),
            status: 'finalizada'
        });
        
        return { success: true, pontuacao };
        
    } catch (error) {
        throw new functions.https.HttpsError('internal', 'Erro ao atualizar prova', error);
    }
});