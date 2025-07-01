
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static('public'));
app.use(express.json());

// Enhanced data structures
let waitingTextUsers = new Map();
let waitingVideoUsers = new Map();
let activeConnections = new Map();
let userPreferences = new Map();
let connectionAttempts = new Map();
let blockedPairs = new Set();
let userSessions = new Map();
let userLocations = new Map();
let userCount = 0;
let totalConnections = 0;

// Enhanced configuration
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAY = 1500;
const MATCH_TIMEOUT = 30000;
const BLOCKED_PAIR_TIMEOUT = 600000; // 10 minutes
const SESSION_TIMEOUT = 3600000; // 1 hour
const MAX_WAITING_TIME = 120000; // 2 minutes

io.on('connection', (socket) => {
  userCount++;
  totalConnections++;
  
  // Generate unique session ID
  const sessionId = crypto.randomBytes(16).toString('hex');
  userSessions.set(socket.id, {
    sessionId,
    joinTime: Date.now(),
    country: null,
    lastActivity: Date.now()
  });
  
  console.log(`User connected: ${socket.id}, Session: ${sessionId}, Total users: ${userCount}`);
  
  // Update user count and stats for all clients
  io.emit('userCount', userCount);
  io.emit('totalConnections', totalConnections);
  
  // Request user location for better matching
  socket.emit('requestLocation');

  // Handle user location for geographic matching
  socket.on('userLocation', (data) => {
    if (data && data.country) {
      userLocations.set(socket.id, {
        country: data.country,
        continent: data.continent || 'Unknown',
        timezone: data.timezone || null
      });
      console.log(`User ${socket.id} location: ${data.country}`);
    }
  });

  socket.on('findPartner', (preferences = {}) => {
    const { interests = [], preferSameCountry = false } = preferences;
    const chatType = 'text'; // Always text chat
    
    // Update last activity
    const session = userSessions.get(socket.id);
    if (session) {
      session.lastActivity = Date.now();
    }
    
    // Store user preferences with enhanced data
    userPreferences.set(socket.id, { 
      chatType, 
      interests, 
      preferSameCountry,
      socket,
      joinTime: Date.now(),
      previousPartners: []
    });
    
    // Use text waiting list only
    const waitingList = waitingTextUsers;
    
    // Find compatible partner with advanced matching
    const compatiblePartner = findCompatiblePartner(socket.id, waitingList);
    
    if (compatiblePartner) {
      // Remove partner from waiting list
      waitingList.delete(compatiblePartner.id);
      
      // Create connection
      createConnection(socket, compatiblePartner, chatType);
    } else {
      // Add to waiting list with timeout
      waitingList.set(socket.id, {
        socket,
        joinTime: Date.now(),
        preferences: { chatType, interests, preferSameCountry }
      });
      
      socket.emit('waiting', { chatType, queuePosition: waitingList.size });
      console.log(`${socket.id} added to text waiting list (${waitingList.size} waiting)`);
      
      // Set timeout for waiting users
      setTimeout(() => {
        if (waitingList.has(socket.id)) {
          socket.emit('waitingTimeout');
          waitingList.delete(socket.id);
        }
      }, MAX_WAITING_TIME);
    }
  });

  // Enhanced retry connection logic with exponential backoff
  socket.on('retryConnection', () => {
    const attempts = connectionAttempts.get(socket.id) || 0;
    
    if (attempts < MAX_RETRY_ATTEMPTS) {
      const newAttempts = attempts + 1;
      connectionAttempts.set(socket.id, newAttempts);
      
      // Exponential backoff: 1.5s, 3s, 4.5s, 6s, 7.5s
      const delay = RETRY_DELAY * newAttempts;
      
      setTimeout(() => {
        const userPref = userPreferences.get(socket.id);
        if (userPref && socket.connected) {
          // Clear from waiting lists first
          waitingTextUsers.delete(socket.id);
          waitingVideoUsers.delete(socket.id);
          
          // Try to find partner again
          socket.emit('findPartner', userPref);
        }
      }, delay);
      
      socket.emit('retryAttempt', { 
        attempt: newAttempts, 
        maxAttempts: MAX_RETRY_ATTEMPTS,
        nextRetryIn: delay
      });
      
      console.log(`Retry attempt ${newAttempts}/${MAX_RETRY_ATTEMPTS} for ${socket.id}`);
    } else {
      socket.emit('maxRetriesReached');
      connectionAttempts.delete(socket.id);
      console.log(`Max retries reached for ${socket.id}`);
    }
  });

  

  socket.on('sendMessage', (data) => {
    const partnerId = activeConnections.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('receiveMessage', {
          message: data.message,
          timestamp: new Date().toISOString()
        });
      }
    }
  });

  socket.on('typing', () => {
    const partnerId = activeConnections.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('partnerTyping');
      }
    }
  });

  socket.on('stopTyping', () => {
    const partnerId = activeConnections.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('partnerStoppedTyping');
      }
    }
  });

  socket.on('disconnect', (reason) => {
    userCount--;
    console.log(`User disconnected: ${socket.id}, Reason: ${reason}, Total users: ${userCount}`);
    
    // Update user count
    io.emit('userCount', userCount);
    
    // Enhanced cleanup
    waitingTextUsers.delete(socket.id);
    waitingVideoUsers.delete(socket.id);
    userPreferences.delete(socket.id);
    connectionAttempts.delete(socket.id);
    userSessions.delete(socket.id);
    userLocations.delete(socket.id);
    
    // Notify partner if in active conversation
    const partnerId = activeConnections.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('partnerDisconnected', { reason: 'disconnect' });
        
        // Update partner's preferences to remember this disconnection
        const partnerPref = userPreferences.get(partnerId);
        if (partnerPref && partnerPref.previousPartners) {
          partnerPref.previousPartners.push(socket.id);
        }
      }
      activeConnections.delete(partnerId);
      
      // Add to blocked pairs with longer timeout for disconnect
      const pairKey = [socket.id, partnerId].sort().join('-');
      blockedPairs.add(pairKey);
      setTimeout(() => blockedPairs.delete(pairKey), BLOCKED_PAIR_TIMEOUT);
      
      console.log(`Disconnected user ${socket.id} had partner ${partnerId}`);
    }
    activeConnections.delete(socket.id);
  });

  socket.on('newChat', () => {
    // Disconnect current partner
    const partnerId = activeConnections.get(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('partnerDisconnected');
      }
      activeConnections.delete(partnerId);
    }
    activeConnections.delete(socket.id);
    
    // Find new partner
    socket.emit('chatEnded');
  });
});

// Enhanced helper functions
function findCompatiblePartner(userId, waitingList) {
  if (waitingList.size === 0) return null;
  
  const userPref = userPreferences.get(userId);
  const userLocation = userLocations.get(userId);
  if (!userPref) return null;
  
  // Convert Map to Array for processing
  const waitingArray = Array.from(waitingList.entries());
  
  // Scoring system for partner matching with video chat prioritization
  const scoredPartners = waitingArray.map(([partnerId, partnerData]) => {
    const partnerPref = userPreferences.get(partnerId);
    const partnerLocation = userLocations.get(partnerId);
    
    if (!partnerPref) return null;
    
    let score = 0;
    
    // Check if pair was recently blocked
    const pairKey = [userId, partnerId].sort().join('-');
    if (blockedPairs.has(pairKey)) return null;
    
    // Check if user has chatted with this partner before
    if (userPref.previousPartners && userPref.previousPartners.includes(partnerId)) {
      score -= 30; // Reduced penalty to allow more matches
    }
    
    // Chat type compatibility (essential - always text)
    if (userPref.chatType === partnerPref.chatType && userPref.chatType === 'text') {
      score += 100;
    } else {
      return null; // Must be text chat
    }
    
    // Geographic preference with enhanced scoring
    if (userLocation && partnerLocation) {
      if (userLocation.country === partnerLocation.country) {
        score += 25;
      } else if (userLocation.continent === partnerLocation.continent) {
        score += 10;
      }
      
      // Timezone proximity bonus
      if (userLocation.timezone && partnerLocation.timezone) {
        score += 5;
      }
    }
    
    // Interest matching with better weighting
    if (userPref.interests && partnerPref.interests) {
      const commonInterests = userPref.interests.filter(interest => 
        partnerPref.interests.includes(interest)
      );
      score += commonInterests.length * 15;
    }
    
    // Waiting time bonus (longer waiting = higher priority)
    const waitingTime = Date.now() - partnerData.joinTime;
    const waitingBonus = Math.min(waitingTime / 1000, 80); // Max 80 points for waiting
    score += waitingBonus;
    
    // Connection quality bonus (prioritize users likely to have stable connections)
    const currentHour = new Date().getHours();
    if (currentHour >= 18 && currentHour <= 23) { // Peak hours
      score += 10;
    }
    
    // Random factor for variety (reduced to make matching more predictable)
    score += Math.random() * 15;
    
    return {
      partnerId,
      partnerData,
      score,
      waitingTime
    };
  }).filter(partner => partner !== null);
  
  if (scoredPartners.length === 0) return null;
  
  // Sort by score (highest first) and return best match
  scoredPartners.sort((a, b) => b.score - a.score);
  
  const bestMatch = scoredPartners[0];
  const chatType = userPref.chatType;
  const waitingTimeMs = bestMatch.waitingTime;
  
  console.log(`✓ Matched ${userId} with ${bestMatch.partnerId} [${chatType}] (score: ${bestMatch.score.toFixed(2)}, waited: ${(waitingTimeMs/1000).toFixed(1)}s)`);
  
  return bestMatch.partnerData.socket;
}

function createConnection(socket1, socket2, chatType) {
  // Create bidirectional connection
  activeConnections.set(socket1.id, socket2.id);
  activeConnections.set(socket2.id, socket1.id);
  
  // Reset retry attempts
  connectionAttempts.delete(socket1.id);
  connectionAttempts.delete(socket2.id);
  
  // Update user preferences to track this connection
  const user1Pref = userPreferences.get(socket1.id);
  const user2Pref = userPreferences.get(socket2.id);
  
  if (user1Pref) {
    if (!user1Pref.previousPartners) user1Pref.previousPartners = [];
    user1Pref.currentPartner = socket2.id;
  }
  
  if (user2Pref) {
    if (!user2Pref.previousPartners) user2Pref.previousPartners = [];
    user2Pref.currentPartner = socket1.id;
  }
  
  // Get location info for enhanced connection data
  const user1Location = userLocations.get(socket1.id);
  const user2Location = userLocations.get(socket2.id);
  
  // Notify both users with enhanced data
  const connectionData = { 
    chatType: 'text',
    timestamp: new Date().toISOString(),
    connectionId: crypto.randomBytes(8).toString('hex')
  };
  
  socket1.emit('partnerFound', { 
    ...connectionData, 
    partnerId: socket2.id,
    partnerCountry: user2Location?.country || 'Unknown'
  });
  
  socket2.emit('partnerFound', { 
    ...connectionData, 
    partnerId: socket1.id,
    partnerCountry: user1Location?.country || 'Unknown'
  });
  
  console.log(`✓ Connected ${socket1.id} (${user1Location?.country || 'Unknown'}) ↔ ${socket2.id} (${user2Location?.country || 'Unknown'}) [text]`);
}

// Cleanup function for expired sessions
setInterval(() => {
  const now = Date.now();
  
  // Clean up expired sessions
  for (const [socketId, session] of userSessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      userSessions.delete(socketId);
      userPreferences.delete(socketId);
      userLocations.delete(socketId);
    }
  }
  
  // Clean up old blocked pairs
  const expiredPairs = [];
  for (const pairKey of blockedPairs) {
    // This is a simple cleanup - in production you'd want to track timestamps
    if (Math.random() < 0.01) { // 1% chance to clean up each interval
      expiredPairs.push(pairKey);
    }
  }
  expiredPairs.forEach(pair => blockedPairs.delete(pair));
  
}, 300000); // Run every 5 minutes

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
