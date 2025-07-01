class AnonChat {
    constructor() {
        this.socket = io();
        this.isConnected = false;
        this.partnerId = null;
        this.typingTimer = null;
        this.chatType = 'text'; // Always text chat
        this.retryAttempts = 0;
        this.maxRetries = 3;

        this.initializeElements();
        this.bindEvents();
        this.setupSocketListeners();
        this.setupGeolocation();
    }

    initializeElements() {
        this.landingPage = document.getElementById('landingPage');
        this.chatInterface = document.getElementById('chatInterface');
        this.startChatBtn = document.getElementById('startChatBtn');
        this.newChatBtn = document.getElementById('newChatBtn');
        this.endChatBtn = document.getElementById('endChatBtn');
        this.retryBtn = document.getElementById('retryBtn');
        this.messageInput = document.getElementById('messageInput');
        this.sendBtn = document.getElementById('sendBtn');
        this.chatMessages = document.getElementById('chatMessages');
        this.statusText = document.getElementById('statusText');
        this.statusIndicator = document.getElementById('statusIndicator');
        this.typingIndicator = document.getElementById('typingIndicator');
        this.userCount = document.getElementById('userCount');
        this.retryStatus = document.getElementById('retryStatus');
        this.retryCount = document.getElementById('retryCount');
    }

    bindEvents() {
        this.startChatBtn.addEventListener('click', () => this.startChat());
        this.newChatBtn.addEventListener('click', () => this.startNewChat());
        this.endChatBtn.addEventListener('click', () => this.endChat());
        this.retryBtn.addEventListener('click', () => this.retryConnection());
        this.sendBtn.addEventListener('click', () => this.sendMessage());

        this.messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.sendMessage();
            } else {
                this.handleTyping();
            }
        });

        this.messageInput.addEventListener('input', () => {
            this.sendBtn.disabled = this.messageInput.value.trim() === '';
        });

        this.messageInput.addEventListener('keyup', () => {
            clearTimeout(this.typingTimer);
            this.typingTimer = setTimeout(() => {
                this.socket.emit('stopTyping');
            }, 1000);
        });
    }

    setupGeolocation() {
        // Request location for better matching
        this.socket.on('requestLocation', () => {
            this.getLocationInfo();
        });
    }

    async getLocationInfo() {
        try {
            await this.getFallbackLocation();
        } catch (error) {
            console.log('Location detection failed, continuing without location');
            this.socket.emit('userLocation', {
                country: 'Unknown',
                continent: 'Unknown',
                timezone: null
            });
        }
    }

    async getFallbackLocation() {
        try {
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

            // Try multiple location services
            const services = [
                'https://ipapi.co/json/',
                'https://api.ipify.org?format=json',
                'https://httpbin.org/ip'
            ];

            for (const serviceUrl of services) {
                try {
                    const response = await fetch(serviceUrl);
                    const data = await response.json();

                    if (data.country_name || data.country) {
                        this.socket.emit('userLocation', {
                            country: data.country_name || data.country || 'Unknown',
                            continent: data.continent || 'Unknown',
                            timezone: timezone
                        });
                        return;
                    }
                } catch (serviceError) {
                    console.log(`Service ${serviceUrl} failed, trying next...`);
                    continue;
                }
            }

            // If all services fail, send basic info
            this.socket.emit('userLocation', {
                country: 'Unknown',
                continent: 'Unknown',
                timezone: timezone
            });
        } catch (error) {
            console.log('All location services failed');
            this.socket.emit('userLocation', {
                country: 'Unknown',
                continent: 'Unknown',
                timezone: null
            });
        }
    }

    setupSocketListeners() {
        this.socket.on('userCount', (count) => {
            this.userCount.textContent = count;
        });

        this.socket.on('totalConnections', (total) => {
            console.log(`Total connections since start: ${total}`);
        });

        this.socket.on('waiting', (data) => {
            const queueInfo = data.queuePosition ? ` (${data.queuePosition} in queue)` : '';
            this.updateStatus(`Waiting for a stranger...${queueInfo}`, 'waiting');
            this.hideRetryStatus();
        });

        this.socket.on('waitingTimeout', () => {
            this.updateStatus('No matches found. Try again?', 'disconnected');
            this.showMessage('Unable to find a match after waiting. You can try again.', 'system');
            this.retryBtn.classList.remove('hidden');
        });

        this.socket.on('partnerFound', (data) => {
            this.partnerId = data.partnerId;
            this.isConnected = true;

            const locationInfo = data.partnerCountry && data.partnerCountry !== 'Unknown' 
                ? ` from ${data.partnerCountry}` 
                : '';

            this.updateStatus(`Connected to stranger${locationInfo}`, 'connected');
            this.clearWelcomeMessage();
            this.hideRetryStatus();
            this.retryAttempts = 0;

            // Show connection success message
            if (data.partnerCountry && data.partnerCountry !== 'Unknown') {
                this.showMessage(`Connected to someone from ${data.partnerCountry}!`, 'system');
            }
        });

        this.socket.on('receiveMessage', (data) => {
            this.displayMessage(data.message, 'stranger', data.timestamp);
        });

        this.socket.on('partnerTyping', () => {
            this.showTypingIndicator();
        });

        this.socket.on('partnerStoppedTyping', () => {
            this.hideTypingIndicator();
        });

        this.socket.on('partnerDisconnected', () => {
            this.handlePartnerDisconnect();
        });

        this.socket.on('chatEnded', () => {
            this.resetChat();
        });

        this.socket.on('retryAttempt', (data) => {
            this.showRetryStatus(data.attempt, data.maxAttempts, data.nextRetryIn);
        });

        this.socket.on('maxRetriesReached', () => {
            this.showMaxRetriesReached();
        });
    }

    async startChat() {
        this.landingPage.classList.add('hidden');
        this.chatInterface.classList.remove('hidden');
        this.updateStatus('Connecting...', 'connecting');

        this.socket.emit('findPartner', { 
            chatType: 'text',
            interests: [],
            preferSameCountry: false 
        });

        this.messageInput.focus();
    }

    startNewChat() {
        this.socket.emit('newChat');
        this.clearMessages();
        this.addWelcomeMessage();
        this.updateStatus('Looking for a new stranger...', 'waiting');
        this.socket.emit('findPartner', { chatType: 'text' });
        this.messageInput.focus();
    }

    endChat() {
        this.resetChat();
        this.landingPage.classList.remove('hidden');
        this.chatInterface.classList.add('hidden');
    }

    retryConnection() {
        this.hideRetryStatus();
        this.retryBtn.classList.add('hidden');
        this.socket.emit('retryConnection');
    }

    resetChat() {
        this.isConnected = false;
        this.partnerId = null;
        this.clearMessages();
        this.addWelcomeMessage();
        this.hideTypingIndicator();
        this.hideRetryStatus();
        this.messageInput.value = '';
        this.sendBtn.disabled = true;
        this.retryAttempts = 0;
    }

    sendMessage() {
        const message = this.messageInput.value.trim();
        if (message && this.isConnected) {
            this.socket.emit('sendMessage', { message });
            this.displayMessage(message, 'you');
            this.messageInput.value = '';
            this.sendBtn.disabled = true;
            this.messageInput.focus();
        }
    }

    displayMessage(message, sender, timestamp = null) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}`;

        const messageContent = document.createElement('div');
        messageContent.textContent = message;
        messageDiv.appendChild(messageContent);

        if (timestamp || sender === 'you') {
            const timeDiv = document.createElement('div');
            timeDiv.className = 'message-time';
            timeDiv.textContent = timestamp ? 
                new Date(timestamp).toLocaleTimeString() : 
                new Date().toLocaleTimeString();
            messageDiv.appendChild(timeDiv);
        }

        this.chatMessages.appendChild(messageDiv);
        this.scrollToBottom();
    }

    showMessage(message, type) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `welcome-message ${type}`;
        messageDiv.innerHTML = `<p><i class="fas fa-info-circle"></i> ${message}</p>`;
        this.chatMessages.appendChild(messageDiv);
        this.scrollToBottom();
    }

    updateStatus(text, type) {
        this.statusText.textContent = text;
        this.statusIndicator.className = `status-indicator ${type}`;
    }

    handleTyping() {
        if (this.isConnected) {
            this.socket.emit('typing');
        }
    }

    showTypingIndicator() {
        this.typingIndicator.classList.remove('hidden');
        this.scrollToBottom();
    }

    hideTypingIndicator() {
        this.typingIndicator.classList.add('hidden');
    }

    showRetryStatus(attempt, maxAttempts, nextRetryIn) {
        this.retryCount.textContent = `Attempt ${attempt}/${maxAttempts}`;
        this.retryStatus.classList.remove('hidden');
        this.retryBtn.classList.add('hidden');
        this.updateStatus('Connection failed, retrying...', 'connecting');

        if (nextRetryIn) {
            let countdown = Math.ceil(nextRetryIn / 1000);
            const countdownInterval = setInterval(() => {
                this.retryCount.textContent = `Attempt ${attempt}/${maxAttempts} - Retrying in ${countdown}s`;
                countdown--;

                if (countdown <= 0) {
                    clearInterval(countdownInterval);
                    this.retryCount.textContent = `Attempt ${attempt}/${maxAttempts}`;
                }
            }, 1000);
        }
    }

    hideRetryStatus() {
        this.retryStatus.classList.add('hidden');
        this.retryBtn.classList.add('hidden');
    }

    showMaxRetriesReached() {
        this.hideRetryStatus();
        this.updateStatus('Max retries reached. Try again later.', 'disconnected');
        this.showMessage('Unable to find a connection. Please try again later.', 'system');
    }

    handlePartnerDisconnect() {
        this.isConnected = false;
        this.partnerId = null;
        this.updateStatus('Stranger disconnected', 'disconnected');
        this.hideTypingIndicator();

        const disconnectMessage = document.createElement('div');
        disconnectMessage.className = 'welcome-message';
        disconnectMessage.innerHTML = '<p><i class="fas fa-user-times"></i> Stranger has disconnected. Click "New Chat" to find someone new!</p>';
        this.chatMessages.appendChild(disconnectMessage);
        this.scrollToBottom();
    }

    clearMessages() {
        this.chatMessages.innerHTML = '';
    }

    addWelcomeMessage() {
        const welcomeDiv = document.createElement('div');
        welcomeDiv.className = 'welcome-message';
        welcomeDiv.innerHTML = '<p><i class="fas fa-comments"></i> You\'re now chatting with a random stranger. Say hello!</p>';
        this.chatMessages.appendChild(welcomeDiv);
    }

    clearWelcomeMessage() {
        const welcomeMessage = this.chatMessages.querySelector('.welcome-message');
        if (welcomeMessage) {
            welcomeMessage.remove();
        }
    }

    scrollToBottom() {
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }
}

// Initialize the chat application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new AnonChat();
});

// Enhanced easter eggs
const konamiCode = [38, 38, 40, 40, 37, 39, 37, 39, 66, 65];
let konamiIndex = 0;

document.addEventListener('keydown', (e) => {
    if (e.keyCode === konamiCode[konamiIndex]) {
        konamiIndex++;
        if (konamiIndex === konamiCode.length) {
            document.body.style.filter = 'hue-rotate(180deg)';
            setTimeout(() => {
                document.body.style.filter = '';
            }, 3000);
            konamiIndex = 0;
        }
    } else {
        konamiIndex = 0;
    }
});

// Connection quality indicator
let connectionQuality = 'good';
setInterval(() => {
    // Simulate connection quality monitoring
    const ping = Math.random() * 200;
    if (ping < 50) connectionQuality = 'excellent';
    else if (ping < 100) connectionQuality = 'good';
    else if (ping < 150) connectionQuality = 'fair';
    else connectionQuality = 'poor';
}, 5000);