import {fetchBoneData} from "./api.js";
import {displayColoredRegions} from "./coloredRegionsOverlay.js";

class QuizManager {
    constructor() {
        this.questions = [];
        this.currentQuestionIndex = 0;
        this.score = 0;
        this.totalQuestions = 10;
        this.allBones = [];
        this.allSubbones = [];
        this.masterQuestionPool = [];
        this.answered = false;
    }

    /**
     * Initialize the quiz system
     */
    async initialize(data) {
        this.allBones = data.bones || [];
        this.allSubbones = data.subbones || [];

        this.createMasterQuestionPool();

        if (this.masterQuestionPool.length < 4) {
            throw new Error(`Not enough items to create a quiz. Need at least 4 items. (Quiz pool length: ${this.masterQuestionPool.length})`);
        }

        this.setupEventListeners();
        return true;
    }

    /**
     * Create a master pool of all bones and subbones
     */
    createMasterQuestionPool() {
        this.masterQuestionPool = [];
        
        // Add all bones to the pool
        this.allBones.forEach(bone => {
            this.masterQuestionPool.push({
                id: bone.id,
                name: bone.name,
                type: "bone"
            });
        });

        // Add all subbones to the pool
        this.allSubbones.forEach(subbone => {
            this.masterQuestionPool.push({
                id: subbone.id,
                name: subbone.name,
                type: "subbone"
            });
        });

        console.log(`Master question pool created with ${this.masterQuestionPool.length} items`);
    }

    /**
     * Setup event listeners for quiz UI
     */
    setupEventListeners() {
        const quizButton = document.getElementById("start-quiz-btn");
        const exitButton = document.getElementById("exit-quiz-btn");
        const nextButton = document.getElementById("next-question-btn");

        if (quizButton) {
            quizButton.addEventListener("click", () => this.startQuiz());
        }

        if (exitButton) {
            exitButton.addEventListener("click", () => this.exitQuiz());
        }

        if (nextButton) {
            nextButton.addEventListener("click", () => this.nextQuestion());
        }
    }

    /**
     * Generate quiz questions using the master pool
     */
    generateQuestions() {
        this.questions = [];
        const usedItems = new Set();

        // Generate specified number of questions
        for (let i = 0; i < this.totalQuestions && this.masterQuestionPool.length >= 4; i++) {
            // Get a random item from master pool that hasn't been used
            let correctItem;
            let attempts = 0;
            do {
                correctItem = this.masterQuestionPool[Math.floor(Math.random() * this.masterQuestionPool.length)];
                attempts++;
            } while (usedItems.has(correctItem.id) && attempts < 50);

            if (usedItems.has(correctItem.id)) break; // Skip if we can't find unused item

            usedItems.add(correctItem.id);

            // Generate wrong answers from items that are NOT the correct answer
            const wrongAnswers = this.generateWrongAnswers(correctItem.id, 3);

            // Create question object
            const question = {
                itemId: correctItem.id,
                itemName: correctItem.name,
                correctAnswer: correctItem.name,
                allAnswers: this.shuffleArray([correctItem.name, ...wrongAnswers]),
            };

            this.questions.push(question);
        }

        console.log(`Generated ${this.questions.length} questions`);
    }

    /**
     * Generate wrong answer choices from the master pool
     */
    generateWrongAnswers(correctItemId, count) {
        const wrongAnswers = [];
        
        // Create distractor pool: all items EXCEPT the correct answer
        const distractorPool = this.masterQuestionPool.filter(item => item.id !== correctItemId);

        // Randomly select 'count' items from distractor pool
        while (wrongAnswers.length < count && distractorPool.length > 0) {
            const randomIndex = Math.floor(Math.random() * distractorPool.length);
            const item = distractorPool.splice(randomIndex, 1)[0];
            wrongAnswers.push(item.name);
        }

        return wrongAnswers;
    }

    /**
     * Shuffle array using Fisher-Yates algorithm
     */
    shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    /**
 * Fetch and display bone image from API
 */
async fetchBoneImage(itemId, container) {
    try {
        const data = await fetchBoneData(itemId);

        console.debug(`Bone data for ${itemId}:`, data);
        
        // Check if image exists in the response
        if (data.images && data.images.length > 0) {
            // Create image element with error handling
            let imageUrl = data.images[0].url;
            const img = document.createElement("img");
            img.src = imageUrl;
            img.alt = "Bone image for quiz question";
            img.style.maxWidth = "100%";
            img.style.maxHeight = "400px";
            img.style.objectFit = "contain";
            img.style.borderRadius = "8px";
            
            img.onerror = () => {
                console.error(`Failed to load image from: ${imageUrl}`);
                container.innerHTML = `
                    <div class="quiz-image-placeholder">
                        <p style="font-size: 4rem;">🦴</p>
                        <p style="color: #666;">Image failed to load</p>
                        <p style="color: #999; font-size: 0.8rem;">${itemId}</p>
                    </div>
                `;
            };
            
            img.onload = () => {
                displayColoredRegions(img, itemId, 0).catch(err => {
                    console.warn(`Could not display colored regions for ${itemId}:`, err);
                });
                console.log(`Image loaded successfully for ${itemId}`);
            };
            
            container.innerHTML = "";
            container.appendChild(img);
        } else {
            console.warn(`No images found for ${itemId}`);
            // No image available - show placeholder
            container.innerHTML = `
                <div class="quiz-image-placeholder">
                    <p style="font-size: 4rem;">🦴</p>
                    <p style="color: #666;">Image not available</p>
                    <p style="color: #999; font-size: 0.8rem;">${itemId}</p>
                </div>
            `;
        }
    } catch (error) {
        console.error(`Error fetching image for ${itemId}:`, error);
        // Show error placeholder
        container.innerHTML = `
            <div class="quiz-image-placeholder">
                <p style="font-size: 4rem;">🦴</p>
                <p style="color: #666;">Unable to load image</p>
                <p style="color: #999; font-size: 0.8rem;">${error.message}</p>
            </div>
        `;
    }
}

    /**
     * Start the quiz
     */
    /**
 * Start the quiz
 */
startQuiz() {
    // Generate questions
    this.generateQuestions();

    if (this.questions.length === 0) {
        alert("Unable to generate quiz questions. Please try again.");
        return;
    }

    // Reset quiz state
    this.currentQuestionIndex = 0;
    this.score = 0;
    this.answered = false;

    // Show quiz container, hide main content
    this.showQuizMode();

        // Restore the quiz structure (in case we're coming from results screen)
    const quizContainer = document.getElementById("quiz-container");
    if (quizContainer) {
        quizContainer.innerHTML = `
            <div class="quiz-header">
                <div class="quiz-info">
                    <span id="quiz-progress">Question 1 of ${this.questions.length}</span>
                    <span id="quiz-score">Score: 0/${this.questions.length}</span>
                </div>
                <button id="exit-quiz-btn">EXIT QUIZ</button>
            </div>
            
            <div class="quiz-content">
                <h2 id="quiz-question-text">What bone or bone part is this?</h2>
                <div id="quiz-bone-image"></div>
                <div id="quiz-choices"></div>
            </div>
            
            <div id="quiz-feedback" style="display: none;"></div>
            
            <div class="quiz-actions">
                <button id="next-question-btn" style="display: none;">NEXT QUESTION</button>
            </div>
        `;

        // Re-attach exit button listener
        const exitBtn = document.getElementById("exit-quiz-btn");
        if (exitBtn) {
            exitBtn.onclick = () => this.exitQuiz();
        }

        // Re-attach next button listener
        const nextBtn = document.getElementById("next-question-btn");
        if (nextBtn) {
            nextBtn.onclick = () => this.nextQuestion();
        }
    }

    // Display first question
    this.displayQuestion();
}

    /**
     * Display current question
     */
    displayQuestion() {
        if (this.currentQuestionIndex >= this.questions.length) {
            this.showResults();
            return;
        }

        const question = this.questions[this.currentQuestionIndex];
        this.answered = false;

        // Update progress
        const progressText = document.getElementById("quiz-progress");
        if (progressText) {
            progressText.textContent = `Question ${this.currentQuestionIndex + 1} of ${this.questions.length}`;
        }

        // Update score display
        const scoreText = document.getElementById("quiz-score");
        if (scoreText) {
            scoreText.textContent = `Score: ${this.score}/${this.questions.length}`;
        }

        // Update question text
        const questionText = document.getElementById("quiz-question-text");
        if (questionText) {
            questionText.textContent = "What bone or bone part is this?";
        }

        // Update bone image - fetch from API
        const imageContainer = document.getElementById("quiz-bone-image");
        if (imageContainer) {
            imageContainer.innerHTML = `
                <div class="quiz-image-placeholder">
                    <p style="font-size: 4rem;">🦴</p>
                    <p>Loading image...</p>
                </div>
            `;
            
            // Fetch bone data with image
            this.fetchBoneImage(question.itemId, imageContainer);
        }

        // Display answer choices
        this.displayAnswerChoices(question);

        // Hide next button, show answer choices
        const nextBtn = document.getElementById("next-question-btn");
        if (nextBtn) nextBtn.style.display = "none";

        // Clear feedback
        const feedback = document.getElementById("quiz-feedback");
        if (feedback) {
            feedback.style.display = "none";
            feedback.className = "quiz-feedback";
        }
    }

    /**
     * Display answer choice buttons
     */
    displayAnswerChoices(question) {
        const choicesContainer = document.getElementById("quiz-choices");
        if (!choicesContainer) return;

        choicesContainer.innerHTML = "";

        question.allAnswers.forEach(answer => {
            const button = document.createElement("button");
            button.className = "quiz-choice-btn";
            button.textContent = answer;
            button.dataset.answer = answer;
            button.addEventListener("click", () => this.handleAnswerClick(answer, question.correctAnswer));
            choicesContainer.appendChild(button);
        });
    }

    /**
     * Handle answer selection
     */
    handleAnswerClick(selectedAnswer, correctAnswer) {
        if (this.answered) return; // Prevent multiple answers
        this.answered = true;

        const isCorrect = selectedAnswer === correctAnswer;

        // Update score
        if (isCorrect) {
            this.score++;
        }

        // Update score display
        const scoreText = document.getElementById("quiz-score");
        if (scoreText) {
            scoreText.textContent = `Score: ${this.score}/${this.questions.length}`;
        }

        // Highlight answers
        const buttons = document.querySelectorAll(".quiz-choice-btn");
        buttons.forEach(btn => {
            btn.disabled = true;
            const answer = btn.dataset.answer;

            if (answer === correctAnswer) {
                btn.classList.add("correct");
            } else if (answer === selectedAnswer && !isCorrect) {
                btn.classList.add("incorrect");
            }
        });

        // Show feedback
        this.showFeedback(isCorrect, correctAnswer);

        // Show next button
        const nextBtn = document.getElementById("next-question-btn");
        if (nextBtn) {
            nextBtn.style.display = "block";
        }
    }

    /**
     * Show feedback after answer
     */
    showFeedback(isCorrect, correctAnswer) {
        const feedback = document.getElementById("quiz-feedback");
        if (!feedback) return;

        feedback.style.display = "block";

        if (isCorrect) {
            feedback.className = "quiz-feedback correct";
            feedback.innerHTML = `
                <span class="feedback-icon">✓</span>
                <span class="feedback-text">Correct! Great job!</span>
            `;
        } else {
            feedback.className = "quiz-feedback incorrect";
            feedback.innerHTML = `
                <span class="feedback-icon">✗</span>
                <span class="feedback-text">Incorrect. The correct answer is: <strong>${correctAnswer}</strong></span>
            `;
        }
    }

    /**
     * Move to next question
     */
    nextQuestion() {
        this.currentQuestionIndex++;
        this.displayQuestion();
    }

  
    /**
     * Show quiz results
     */
/**
 * Show quiz results
 */
showResults() {
    const percentage = Math.round((this.score / this.questions.length) * 100);
    
    let message = "";
    let emoji = "";
    
    if (percentage >= 90) {
        message = "Outstanding! You're a bone expert!";
        emoji = "🏆";
    } else if (percentage >= 70) {
        message = "Great job! You know your bones well!";
        emoji = "🎉";
    } else if (percentage >= 50) {
        message = "Good effort! Keep studying!";
        emoji = "👍";
    } else {
        message = "Keep practicing! You'll improve with time!";
        emoji = "📚";
    }

    const quizContainer = document.getElementById("quiz-container");
    if (!quizContainer) return;

    quizContainer.innerHTML = `
        <div class="quiz-results">
            <div class="results-emoji">${emoji}</div>
            <h2>Quiz Complete!</h2>
            <div class="results-score">
                <div class="score-number">${this.score}/${this.questions.length}</div>
                <div class="score-percentage">${percentage}%</div>
            </div>
            <p class="results-message">${message}</p>
            <div class="results-buttons">
                <button id="retry-quiz-btn" class="quiz-btn quiz-btn-primary">
                    Try Again
                </button>
                <button id="exit-results-btn" class="quiz-btn quiz-btn-secondary">
                    Exit Quiz
                </button>
            </div>
        </div>
    `;

    // Wait for DOM to be ready, then add event listeners with arrow functions
    requestAnimationFrame(() => {
        const retryBtn = document.getElementById("retry-quiz-btn");
        const exitBtn = document.getElementById("exit-results-btn");

        console.debug("Retry button found:", retryBtn);
        console.debug("Exit button found:", exitBtn);
        
        if (retryBtn) {
            retryBtn.onclick = () => {
                console.debug("TRY AGAIN CLICKED!");
                this.startQuiz();
            };
        }
        
        if (exitBtn) {
            exitBtn.onclick = () => {
                console.log("EXIT CLICKED!"); // Debug
                this.exitQuiz();
            };
        }
    });
}

    /**
     * Show quiz mode (hide main content)
     */
    showQuizMode() {
        const mainContent = document.querySelector(".container");
        const quizModal = document.getElementById("quiz-modal");

        if (mainContent) mainContent.style.display = "none";
        if (quizModal) quizModal.style.display = "flex";
    }

    /**
     * Exit quiz and return to main view
     */
    exitQuiz() {
        this.isQuizActive = false;
        
        const mainContent = document.querySelector(".container");
        const quizModal = document.getElementById("quiz-modal");

        if (mainContent) mainContent.style.display = "block";
        if (quizModal) quizModal.style.display = "none";

        // Reset quiz
        this.currentQuestionIndex = 0;
        this.score = 0;
        this.questions = [];
    }
}

const quizManager = new QuizManager();
export default quizManager;
