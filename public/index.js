       // Configuração Firebase
        const firebaseConfig = {
            apiKey: "AIzaSyDbzqfmNxZjuDbkCmjqrKGhB-rTRT6e3oY",
            authDomain: "tutoria-firebase.firebaseapp.com",
            projectId: "tutoria-firebase",
            storageBucket: "tutoria-firebase.firebasestorage.app",
            messagingSenderId: "1070606817177",
            appId: "1:1070606817177:web:53a2624d04d669ff452508"
        };
        firebase.initializeApp(firebaseConfig);

        const auth = firebase.auth();
        const db = firebase.firestore();
        const functions = firebase.functions();
        let currentTest = {
            provaId: null,
            questions: [],
            isSubmitted: false
        };
        // Emuladores (apenas para desenvolvimento local)
        if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
            auth.useEmulator('http://localhost:9099/');
            db.useEmulator('localhost', 8080);
            functions.useEmulator('localhost', 5001);
        }

        // Variável global para armazenar usuário atual
        let currentUser = null;

        // Verifica autenticação e carrega dados do usuário
        auth.onAuthStateChanged(async user => {
            if (!user) return window.location.replace('login.html');
            
            currentUser = user;
            const userRef = db.collection('users').doc(user.uid);
            const doc = await userRef.get();
            if (!doc.exists) {
                await userRef.set({ nome: user.displayName || 'Usuário', email: user.email });
            }
            const data = (await userRef.get()).data();
            document.getElementById('user-name').textContent = data.nome;
            document.getElementById('user-email').textContent = data.email;
        });

        // Logout
        document.getElementById('btnLogout').addEventListener('click', () => {
            auth.signOut().then(() => {
                window.location.replace('login.html');
            }).catch(error => {
                console.error('Erro ao fazer logout:', error);
            });
        });

        // Funções de navegação por abas
        function showTab(tabName) {
            // Esconder todas as abas
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            
            // Mostrar aba selecionada
            document.getElementById(`tab-${tabName}`).classList.add('active');
            
            // Carregar provas se necessário
            if (tabName === 'minhas-provas') {
                loadUserProvas();
            }
        }

        // MUDANÇA: Carregar provas da subcoleção do usuário
        async function loadUserProvas() {
            if (!currentUser) return;
            
            document.getElementById('loader-provas').classList.remove('hidden');
            document.getElementById('provas-list').innerHTML = '';
            
            try {
                console.log('Carregando provas para usuário:', currentUser.uid);
                
                // Buscar na subcoleção provas do usuário
                const provasQuery = await db.collection('users')
                    .doc(currentUser.uid)
                    .collection('provas')
                    .orderBy('criadaEm', 'desc')
                    .get();
                
                console.log('Número de provas encontradas:', provasQuery.size);
                
                if (provasQuery.empty) {
                    document.getElementById('provas-list').innerHTML = '<p class="success">Você ainda não tem provas salvas. Gere algumas questões primeiro!</p>';
                    return;
                }
                
                let html = '';
                provasQuery.forEach(doc => {
                    const prova = doc.data();
                    console.log('Prova encontrada:', doc.id, prova);
                    
                    const dataFormatada = prova.criadaEm ? 
                        prova.criadaEm.toDate().toLocaleDateString('pt-BR') : 'Data não disponível';
                    
                    html += `
                        <div class="prova-item">
                            <h4>${prova.materia} - ${prova.totalQuestoes} questões</h4>
                            <p>Criada em: ${dataFormatada}</p>
                            <button onclick="viewProva('${doc.id}')">Ver Questões</button>
                            <button onclick="deleteProva('${doc.id}')">Excluir</button>
                        </div>
                    `;
                });
                
                document.getElementById('provas-list').innerHTML = html;
                
            } catch (error) {
                console.error('Erro ao carregar provas:', error);
                document.getElementById('provas-list').innerHTML = '<div class="error">❌ Erro ao carregar provas: ' + error.message + '</div>';
            } finally {
                document.getElementById('loader-provas').classList.add('hidden');
            }
        }

        // MUDANÇA: Visualizar prova da subcoleção
        async function viewProva(provaId) {
            try {
                const provaDoc = await db.collection('users')
                    .doc(currentUser.uid)
                    .collection('provas')
                    .doc(provaId)
                    .get();
                    
                if (!provaDoc.exists) {
                    showError('Prova não encontrada');
                    return;
                }
                
                const prova = provaDoc.data();
                
                // Mudar para aba de gerar questões e mostrar as questões
                showTab('gerar');
                displayQuestions(prova.questoes);
                
            } catch (error) {
                console.error('Erro ao visualizar prova:', error);
                showError('Erro ao carregar prova: ' + error.message);
            }
        }

        // MUDANÇA: Excluir prova da subcoleção
        async function deleteProva(provaId) {
            if (!confirm('Tem certeza que deseja excluir esta prova?')) {
                return;
            }
            
            try {
                await db.collection('users')
                    .doc(currentUser.uid)
                    .collection('provas')
                    .doc(provaId)
                    .delete();
                    
                loadUserProvas(); // Recarregar lista
                alert('Prova excluída com sucesso!');
            } catch (error) {
                console.error('Erro ao excluir prova:', error);
                alert('Erro ao excluir prova: ' + error.message);
            }
        }

        function displayQuestions(questions, provaId) {
            if (!questions || !Array.isArray(questions) || questions.length === 0) {
                showError('Nenhuma questão foi gerada. Por favor, tente novamente.');
                return;
            }

            let html = '';
            const letters = ['A', 'B', 'C', 'D', 'E'];
            
            // Armazenar globalmente para uso posterior
            window.currentTest = {
                questions: questions,
                provaId: provaId || null
            };
            
            questions.forEach((question, index) => {
                html += `
                    <div class="question" id="question-${index}">
                        <h3>Questão ${index + 1}</h3>
                        <p><strong>Enunciado:</strong> ${question.enunciado}</p>
                        <p><strong>Alternativas:</strong></p>
                        <form id="form-${index}">
                `;
                
                question.alternativas.forEach((alt, altIndex) => {
                    const letter = letters[altIndex];
                    html += `
                        <div>
                            <input type="radio" name="q${index}" value="${letter}" id="q${index}_${letter}">
                            <label for="q${index}_${letter}">${letter}) ${alt}</label>
                        </div>
                    `;
                });
                
                html += `
                        </form>
                    </div>
                `;
            });
            
            html += `
                <div>
                    <button id="btnSubmitTest" onclick="submitTest()">Finalizar Prova</button>
                    <button id="btnShowAnswers" class="hidden" onclick="showCorrectAnswers()">Mostrar Gabarito</button>
                </div>
            `;
            
            document.getElementById('result').innerHTML = html;
            currentTest = {
            provaId: provaId || null,
            questions: questions,
            isSubmitted: false
        };
        }

         async function submitTest() {
            
            if (!window.currentTest || !window.currentTest.questions) {
                showError('Nenhuma prova ativa encontrada.');
                return;
            }
            
            const questions = window.currentTest.questions;
            const userAnswers = [];
            let correctCount = 0;
            
            // Coletar respostas do usuário
            questions.forEach((_, index) => {
                const selected = document.querySelector(`input[name="q${index}"]:checked`);
                const answer = selected ? selected.value : null;
                userAnswers.push(answer);
                console.log(userAnswers);
                
                // Verificar se acertou
                if (answer === questions[index].alternativaCorreta) {
                    correctCount++;
                }
            });
            
            // Exibir pontuação
            const scoreElement = document.createElement('div');
            scoreElement.className = 'results-summary';
            scoreElement.innerHTML = `
                <h3>Resultado da Prova</h3>
                <p>Acertos: <strong>${correctCount} de ${questions.length}</strong></p>
                <p>Porcentagem: <strong>${Math.round((correctCount/questions.length)*100)}%</strong></p>
                <p>Clique em "Mostrar Gabarito" para ver as respostas corretas</p>
            `;
            document.getElementById('result').insertBefore(scoreElement, document.getElementById('result').firstChild);
            
            // Mostrar botão de gabarito
            document.getElementById('btnSubmitTest').classList.add('hidden');
            document.getElementById('btnShowAnswers').classList.remove('hidden');
            
            // Armazenar respostas no Firestore se tivermos provaId
            if (window.currentTest.provaId && currentUser) {
                try {
                    await db.collection('users').doc(currentUser.uid).collection('provas')
                        .doc(window.currentTest.provaId).update({
                            respostaUsuario: userAnswers,
                            pontuacao: correctCount,
                            finalizadaEm: firebase.firestore.FieldValue.serverTimestamp(),
                            status: 'finalizada'
                        });
                    console.log('Respostas salvas com sucesso!');
                } catch (error) {
                    console.error('Erro ao salvar respostas:', error);
                }
            }
        }

        function showCorrectAnswers() {
            const questions = window.currentTest.questions;
            
            questions.forEach((question, index) => {
                const questionElement = document.getElementById(`question-${index}`);
                const selected = document.querySelector(`input[name="q${index}"]:checked`);
                const userAnswer = selected ? selected.value : 'Não respondida';
                
                // Adicionar marcação visual
                if (userAnswer === question.alternativaCorreta) {
                    questionElement.classList.add('correct');
                } else {
                    questionElement.classList.add('incorrect');
                }
                
                // Adicionar informação de resposta
                const answerInfo = document.createElement('div');
                answerInfo.className = 'user-answer';
                answerInfo.innerHTML = `
                    <span>Sua resposta: ${userAnswer}</span>
                    <span class="correct-answer"> | Resposta correta: ${question.alternativaCorreta}</span>
                `;
                
                questionElement.appendChild(answerInfo);
                
                // Destacar resposta correta
                const correctRadio = document.getElementById(`q${index}_${question.alternativaCorreta}`);
                if (correctRadio) {
                    correctRadio.parentElement.style.color = 'green';
                    correctRadio.parentElement.style.fontWeight = 'bold';
                }
            });
            
            // Esconder botão após mostrar respostas
            ddocument.getElementById('btnShowAnswers').classList.add('hidden');
        
            // Adicionar mensagem de prova finalizada
            const finishedMsg = document.createElement('div');
            finishedMsg.className = 'success';
            finishedMsg.textContent = 'Prova finalizada. As respostas foram salvas permanentemente.';
            document.getElementById('result').prepend(finishedMsg);
        }

        async function callGenerateQuestions(count) {
            const subject = document.getElementById('subject').value.trim();

            if (!subject) {
                showError('Por favor, digite um assunto antes de gerar as questões.');
                return;
            }
            
            const buttons = document.querySelectorAll('button');
            buttons.forEach(btn => btn.disabled = true);
            document.getElementById('loader').classList.remove('hidden');
            document.getElementById('result').innerHTML = '';

            try {
                // MÉTODO 1: Usando httpsCallable
                const generateQuestions = functions.httpsCallable('generateQuestions');
                const result = await generateQuestions({ subject, count });
               
                if (result.data && result.data.questions) {
                    displayQuestions(result.data.questions, result.data.provaId);
                    
                    // Mostrar mensagem de sucesso
                    if (result.data.provaId) {
                        const successDiv = document.createElement('div');
                        successDiv.className = 'success';
                        successDiv.innerHTML = `✅ Questões geradas e salvas! ID da prova: ${result.data.provaId}`;
                        document.getElementById('result').insertBefore(successDiv, document.getElementById('result').firstChild);
                    }
                } else {
                    throw new Error('Formato de resposta inválido');
                }

            } catch (error) {
                console.error('Erro ao gerar questões:', error);
                
                // MÉTODO 2: Fallback usando fetch direto
                try {
                    console.log('Tentando método alternativo...');
                   
                    const user = auth.currentUser;
                    if (!user) {
                        throw new Error('Usuário não autenticado');
                    }
                   
                    const token = await user.getIdToken();
                    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
                    const functionUrl = isLocal ?
                        `http://localhost:5001/tutoria-firebase/us-central1/generateQuestions` :
                        `https://us-central1-tutoria-firebase.cloudfunctions.net/generateQuestions`;
                   
                    const response = await fetch(functionUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`,
                        },
                        body: JSON.stringify({
                            data: { subject, count }
                        })
                    });

                    if (!response.ok) {
                        throw new Error(`HTTP error! status: ${response.status}`);
                    }

                    const data = await response.json();
                   
                    if (data.data && data.data.questions) {
                        displayQuestions(data.data.questions);
                        
                        if (data.data.provaId) {
                            const successDiv = document.createElement('div');
                            successDiv.className = 'success';
                            successDiv.innerHTML = `✅ Questões geradas e salvas! ID da prova: ${data.data.provaId}`;
                            document.getElementById('result').insertBefore(successDiv, document.getElementById('result').firstChild);
                        }
                    } else {
                        throw new Error('Formato de resposta inválido no método alternativo');
                    }

                } catch (fetchError) {
                    console.error('Erro no método alternativo:', fetchError);
                    showError(`Falha ao gerar questões. Detalhes: ${error.message || 'Erro desconhecido'}`);
                }
            } finally {
                document.getElementById('loader').classList.add('hidden');
                buttons.forEach(btn => btn.disabled = false);
            }
        }

        function showError(message) {
            document.getElementById('result').innerHTML = `<div class="error">❌ ${message}</div>`;
        }