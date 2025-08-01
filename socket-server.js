require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Configuration
const PORT = process.env.SOCKET_PORT || 3001;
const SECRET_TOKEN = process.env.SOCKET_SERVER_SECRET || 'your-secret-token';
const BETTING_PHASE_DURATION = 6000; // 6 seconds
const WAIT_PHASE_DURATION = 3000; // 3 seconds
const MULTIPLIER_UPDATE_INTERVAL = 150; // 150ms for more believable updates (was 50ms)

// Time-based round calculation (same as backend)
const ROUND_DURATION = 10000; // 10 seconds per round
function getCurrentRound() {
  const today = new Date();
  const BASE_TIMESTAMP = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12, 0, 0);
  const now = Date.now();
  return Math.max(1, Math.floor((now - BASE_TIMESTAMP) / ROUND_DURATION));
}

// Global game state
let multiplierQueue = [];
let roundMultipliers = new Map(); // round -> multiplier mapping
let currentRound = 0; // Use sequential counter, not time-based
let currentMultiplier = 1.00;
let crashPoint = null;
let gamePhase = 'wait'; // 'wait', 'betting', 'flying', 'crashed'
let simulationInterval = null;
let bettingTimer = null;
let waitTimer = null;

// Client-specific state tracking
const clientStates = new Map(); // socketId -> { currentRound, isSynced }

// Middleware
app.use(cors());
app.use(express.json());

// Helper function to get multiplier for a specific round
function getMultiplierForRound(round) {
  const multiplier = roundMultipliers.get(round);
  console.log(`🔍 Looking up round ${round}: ${multiplier || 'not found'}`);
  return multiplier || 1.00;
}

// Authentication middleware
const authenticateRequest = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${SECRET_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Queue endpoint for receiving multipliers from backend
app.post('/queue', authenticateRequest, (req, res) => {
  const { multipliers, startRound } = req.body;
  
  if (!multipliers || !Array.isArray(multipliers)) {
    return res.status(400).json({ error: 'Invalid multipliers array' });
  }
  
  // Add multipliers to queue with round tracking
  const previousQueueSize = multiplierQueue.length;
  
  // Handle both old format (array of numbers) and new format (array of objects)
  const multiplierValues = multipliers.map(item => 
    typeof item === 'number' ? item : item.multiplier
  );
  multiplierQueue.push(...multiplierValues);
  
  // Store multipliers with their round numbers
  multipliers.forEach((item, index) => {
    const multiplier = typeof item === 'number' ? item : item.multiplier;
    const roundNumber = typeof item === 'number' ? (startRound + index) : item.round_number;
    roundMultipliers.set(roundNumber, multiplier);
    console.log(`📋 Mapped round ${roundNumber} → multiplier ${multiplier}`);
  });
  
  console.log(`📥 Queued ${multiplierValues.length} multipliers: [${multiplierValues.join(', ')}]`);
  console.log(`📊 Queue size: ${previousQueueSize} → ${multiplierQueue.length}`);
  console.log(`📋 Full queue: [${multiplierQueue.join(', ')}]`);
  console.log(`⏰ Backend start round: ${startRound}`);
  console.log(`🗺️ Round multipliers: ${Array.from(roundMultipliers.entries()).slice(-5).map(([r, m]) => `${r}:${m}`).join(', ')}`);
  
  // Start simulation if not already running
  if (gamePhase === 'wait' && multiplierQueue.length > 0) {
    console.log(`🚀 Starting simulation with ${multiplierQueue.length} multipliers in queue`);
    
    // Ensure we start with the correct round
    if (startRound) {
      if (currentRound === 0) {
        // First time initialization - set to the exact startRound
        currentRound = startRound;
        console.log(`🎯 First time sync: setting current round to ${startRound}`);
      } else if (currentRound < startRound) {
        // Socket server is behind, catch up to the exact startRound
        console.log(`🎯 Catching up: ${currentRound} → ${startRound}`);
        currentRound = startRound;
      } else if (currentRound > startRound) {
        // Socket server is ahead, this might indicate a gap
        console.log(`⚠️ Socket ahead: ${currentRound} > ${startRound}, checking for gaps`);
        // Check if we have the multiplier for the expected round
        if (!roundMultipliers.has(currentRound)) {
          console.log(`🔍 Gap detected: no multiplier for round ${currentRound}, jumping to ${startRound}`);
          currentRound = startRound;
        }
      } else {
        // Socket server is exactly in sync
        console.log(`✅ Socket server in sync: ${currentRound} = ${startRound}`);
      }
    }
    
    console.log(`🎮 Starting simulation from round ${currentRound}`);
    startNextRound();
  } else if (gamePhase !== 'wait') {
    console.log(`⏳ Simulation already running (phase: ${gamePhase}), queue will be processed after current round`);
  }
  
  res.json({ success: true, queueSize: multiplierQueue.length });
});

// Health check endpoint
app.get('/health', (req, res) => {
  const timeBasedRound = getCurrentRound();
  const roundMultiplier = getMultiplierForRound(currentRound);
  res.json({ 
    status: 'healthy', 
    gamePhase, 
    currentRound, 
    timeBasedRound,
    roundDifference: currentRound - timeBasedRound,
    queueSize: multiplierQueue.length,
    currentMultiplier: gamePhase === 'flying' ? currentMultiplier : roundMultiplier,
    nextMultiplier: multiplierQueue.length > 0 ? multiplierQueue[0] : null
  });
});

// Debug endpoint to show current state
app.get('/debug', (req, res) => {
  const timeBasedRound = getCurrentRound();
  const roundMultiplier = getMultiplierForRound(currentRound);
  res.json({ 
    gamePhase, 
    currentRound, 
    timeBasedRound,
    roundDifference: currentRound - timeBasedRound,
    queueSize: multiplierQueue.length,
    currentMultiplier: gamePhase === 'flying' ? currentMultiplier : roundMultiplier,
    crashPoint,
    queuePreview: multiplierQueue.slice(0, 5),
    roundMultipliers: Array.from(roundMultipliers.entries()).slice(-10),
    activeTimers: {
      simulationInterval: !!simulationInterval,
      bettingTimer: !!bettingTimer,
      waitTimer: !!waitTimer
    }
  });
});

// Current game state endpoint for late joiners
app.get('/current-state', (req, res) => {
  res.json({
    currentRound,
    gamePhase,
    currentMultiplier,
    crashPoint,
    roundStartTime: gamePhase === 'flying' ? Date.now() - (currentMultiplier > 1.0 ? 3000 : 0) : null,
    bettingEndTime: gamePhase === 'betting' ? Date.now() + (BETTING_PHASE_DURATION - (Date.now() % BETTING_PHASE_DURATION)) : null
  });
});

// Manual trigger endpoint (for testing)
app.post('/trigger-next', authenticateRequest, (req, res) => {
  if (gamePhase === 'wait' && multiplierQueue.length > 0) {
    console.log(`🔧 Manual trigger: Starting next round`);
    startNextRound();
    res.json({ success: true, message: 'Next round triggered' });
  } else {
    res.json({ success: false, message: `Cannot trigger next round. Phase: ${gamePhase}, Queue: ${multiplierQueue.length}` });
  }
});

// Test endpoint to check multiplier for a specific round
app.get('/test-round/:round', (req, res) => {
  const round = parseInt(req.params.round, 10);
  const multiplier = getMultiplierForRound(round);
  res.json({ 
    round, 
    multiplier, 
    hasMultiplier: roundMultipliers.has(round),
    allRounds: Array.from(roundMultipliers.keys()).sort((a, b) => a - b),
    recentRounds: Array.from(roundMultipliers.entries()).slice(-10)
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);
  
  // Send current game state to new connection immediately
  socket.emit('game:state', {
    currentRound,
    gamePhase,
    currentMultiplier: gamePhase === 'flying' ? currentMultiplier : (crashPoint || 1.00),
    crashPoint
  });
  
  // Send current round info
  socket.emit('round:info', {
    round: currentRound,
    phase: gamePhase,
    multiplier: currentMultiplier,
    crashPoint
  });
  
  // If currently in betting phase, send betting info
  if (gamePhase === 'betting') {
    socket.emit('round:start', {
      round: currentRound,
      crashPoint: crashPoint
    });
  }
  
  // If currently in flying phase, send flying info
  if (gamePhase === 'flying') {
    socket.emit('round:flying', {
      round: currentRound,
      multiplier: currentMultiplier,
      crashPoint: crashPoint
    });
  }
  
  // If currently crashed, send crash info
  if (gamePhase === 'crashed') {
    socket.emit('round:crash', {
      round: currentRound,
      crashPoint: crashPoint
    });
  }
  
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// Game simulation functions
function startNextRound() {
  if (multiplierQueue.length === 0) {
    console.log('⏸️ No multipliers in queue, pausing simulation');
    gamePhase = 'wait';
    return;
  }
  
  // Get the correct multiplier for this round from the roundMultipliers map
  const roundMultiplier = roundMultipliers.get(currentRound);
  if (!roundMultiplier) {
    console.log(`⚠️ No multiplier found for round ${currentRound}, checking queue...`);
    // Check if we have a multiplier in the queue that we can use
    if (multiplierQueue.length > 0) {
      crashPoint = multiplierQueue.shift();
      console.log(`   Using queue fallback: ${crashPoint}x`);
    } else {
      console.log(`   No multipliers available, waiting...`);
      gamePhase = 'wait';
      return;
    }
  } else {
    crashPoint = roundMultiplier;
    // Remove from queue to keep it in sync
    if (multiplierQueue.length > 0) {
      multiplierQueue.shift();
    }
    console.log(`   Using mapped multiplier: ${crashPoint}x`);
  }
  
  // currentRound is already set to the correct value from backend sync
  currentMultiplier = 1.00;
  
  console.log(`🎮 Starting round ${currentRound} with crash point: ${crashPoint}x (from roundMultipliers: ${roundMultipliers.has(currentRound)})`);
  
  // Start betting phase
  gamePhase = 'betting';
  console.log(`🎯 Emitting round:start with round ${currentRound}`);
  io.emit('round:start', {
    round: currentRound,
    crashPoint: crashPoint
  });
  
  // Transition to flying phase after betting duration
  bettingTimer = setTimeout(() => {
    startFlyingPhase();
  }, BETTING_PHASE_DURATION);
}

function startFlyingPhase() {
  gamePhase = 'flying';
  currentMultiplier = 1.00;
  
  console.log(`✈️ Starting flying phase for round ${currentRound} with EXACT crash point: ${crashPoint}x`);
  
  // Handle very low crash points (instant crash)
  if (crashPoint < 1.03) {
    console.log(`⚡ Instant crash for low multiplier: ${crashPoint}x`);
    currentMultiplier = crashPoint;
    io.emit('multiplier:update', {
      round: currentRound,
      multiplier: currentMultiplier
    });
    crashRound();
    return;
  }
  
  // Record start time for animation
  const startTime = Date.now();
  const timeToCrash = estimateTimeToMultiplier(crashPoint);
  
  // Start multiplier animation
  simulationInterval = setInterval(() => {
    // Calculate elapsed time since flying phase started
    const elapsedMs = Date.now() - startTime;
    const elapsedSec = elapsedMs / 1000;
    
    // Calculate progress (0 to 1)
    const progress = Math.min(1, elapsedSec / timeToCrash);
    
    // Calculate current multiplier
    currentMultiplier = calculateMultiplier(progress, crashPoint);
    
    // Add natural pauses for realism (especially for small multipliers)
    if (crashPoint < 3.0 && Math.random() < 0.12) {
      // 12% chance of a micro-pause for small multipliers (increased from 5%)
      return; // Skip this update to create a pause
    }
    
    // Variable update timing for more realistic feel
    const baseInterval = MULTIPLIER_UPDATE_INTERVAL;
    let variableInterval;
    
    if (crashPoint < 2.0) {
      // Small multipliers: More variable timing for unpredictability
      variableInterval = baseInterval + Math.sin(progress * Math.PI * 3) * 50 + Math.sin(progress * Math.PI * 7) * 30; // ±80ms variation
    } else {
      // Larger multipliers: Standard variation
      variableInterval = baseInterval + Math.sin(progress * Math.PI) * 30; // ±30ms variation
    }
    
    // Debug: Log only significant multiplier changes (less frequent)
    if (currentMultiplier >= 2.0 || (Math.abs(currentMultiplier - crashPoint) < 0.05 && currentMultiplier > 1.5)) {
      console.log(`📊 ${currentMultiplier.toFixed(2)}x → ${crashPoint.toFixed(2)}x (${(progress * 100).toFixed(0)}%)`);
    }
    
    // Emit multiplier update
    io.emit('multiplier:update', {
      round: currentRound,
      multiplier: currentMultiplier
    });
    
    // Check if crashed - only trigger when naturally reaching the target
    if (currentMultiplier >= crashPoint) {
      console.log(`🎯 Animation complete: reached ${currentMultiplier}x (target was ${crashPoint}x)`);
      crashRound();
    }
  }, MULTIPLIER_UPDATE_INTERVAL);
}

function crashRound() {
  gamePhase = 'crashed';
  currentMultiplier = crashPoint;
  
  console.log(`💥 Round ${currentRound} crashed at ${crashPoint}x`);
  
  // Clear simulation interval
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
  
  // Emit crash event
  io.emit('round:crash', {
    round: currentRound,
    crashPoint: crashPoint
  });
  
  // Start wait phase
  waitTimer = setTimeout(() => {
    console.log(`⏭️ Moving to next round...`);
    // Increment current round for the next round in sequence
    currentRound++;
    startNextRound();
  }, WAIT_PHASE_DURATION);
}

// Utility functions
function estimateTimeToMultiplier(target) {
  const baseTime = 8; // Base duration for a 2x multiplier
  const scaledTime = baseTime * Math.pow(target / 2, 0.5);
  return Math.max(scaledTime, 3); // Minimum 3 seconds
}

function calculateMultiplier(progress, target) {
  // Realistic crash game animation - smoothly progresses to crash point
  
  // Start at 1.00 and build tension with natural acceleration
  const startValue = 1.00;
  const range = target - startValue;
  
  // Use easing functions that naturally reach the target
  let multiplier;
  
  if (target < 2.0) {
    // Small multipliers: Highly unpredictable with micro-stalls and variations
    const baseEase = 1 - Math.pow(1 - progress, 2.2); // Slightly more aggressive
    
    // Multiple sine waves for unpredictability
    const variation1 = Math.sin(progress * Math.PI * 3) * 0.008;
    const variation2 = Math.sin(progress * Math.PI * 7) * 0.005;
    const variation3 = Math.cos(progress * Math.PI * 5) * 0.006;
    
    // Micro-stalls that create tension
    const microStall1 = Math.sin(progress * Math.PI * 11) * 0.004;
    const microStall2 = Math.sin(progress * Math.PI * 13) * 0.003;
    
    // Random-like factor based on progress
    const randomFactor = Math.sin(progress * Math.PI * 17) * 0.002;
    
    multiplier = startValue + (range * (baseEase + variation1 + variation2 + variation3 + microStall1 + microStall2 + randomFactor));
  } else if (target < 5.0) {
    // Medium multipliers: Natural acceleration with some unpredictability
    const easeOut = 1 - Math.pow(1 - progress, 1.8); // Slightly aggressive
    const variation = Math.sin(progress * Math.PI * 3) * 0.008; // Small variations
    multiplier = startValue + (range * (easeOut + variation));
  } else if (target < 15.0) {
    // High multipliers: Strong acceleration
    const easeOut = 1 - Math.pow(1 - progress, 1.5); // More aggressive
    const variation = Math.sin(progress * Math.PI * 2.5) * 0.012; // Medium variations
    const microStall = Math.sin(progress * Math.PI * 7) * 0.003; // Micro-stalls
    multiplier = startValue + (range * (easeOut + variation + microStall));
  } else {
    // Very high multipliers: Explosive growth
    const easeOut = 1 - Math.pow(1 - progress, 1.2); // Very aggressive
    const variation = Math.sin(progress * Math.PI * 2) * 0.015; // Larger variations
    const randomFactor = Math.sin(progress * Math.PI * 5) * 0.008; // Additional randomness
    multiplier = startValue + (range * (easeOut + variation + randomFactor));
  }
  
  // Ensure we don't exceed the target
  multiplier = Math.min(multiplier, target);
  
  // Round to 2 decimal places for display
  return parseFloat(multiplier.toFixed(2));
}

// Test function to verify multiplier calculation
function testMultiplierCalculation() {
  console.log(`🧪 Testing Realistic Crash Game Animation:`);
  
  // Test different multiplier types
  const testCases = [
    { target: 1.5, description: "Small multiplier (1.5x) - Slow & steady" },
    { target: 2.5, description: "Medium multiplier (2.5x) - Natural acceleration" },
    { target: 5.0, description: "High multiplier (5.0x) - Strong acceleration" },
    { target: 10.0, description: "Very high multiplier (10.0x) - Explosive growth" }
  ];
  
  testCases.forEach(test => {
    const result = calculateMultiplier(1.0, test.target);
    console.log(`   ${test.description}: ${result.toFixed(2)}x`);
  });
  
  // Test realistic progression for a medium multiplier
  console.log(`\n📈 Realistic Progression (3.0x multiplier):`);
  for (let progress = 0.1; progress <= 1.0; progress += 0.1) {
    const result = calculateMultiplier(progress, 3.0);
    console.log(`   ${(progress * 100).toFixed(0)}%: ${result.toFixed(2)}x`);
  }
  
  console.log(`\n⚡ Features:`);
  console.log(`   • Natural easing curves (feels like real market)`);
  console.log(`   • Micro-variations and stalls for unpredictability`);
  console.log(`   • Variable update timing (±30ms)`);
  console.log(`   • Natural pauses for small multipliers`);
  console.log(`   • Update interval: ${MULTIPLIER_UPDATE_INTERVAL}ms`);
  
  return true;
}

// Cleanup function
function cleanup() {
  if (simulationInterval) {
    clearInterval(simulationInterval);
  }
  if (bettingTimer) {
    clearTimeout(bettingTimer);
  }
  if (waitTimer) {
    clearTimeout(waitTimer);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('🛑 Shutting down socket server...');
  cleanup();
  server.close(() => {
    console.log('✅ Socket server closed');
    process.exit(0);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Socket.IO server running on port ${PORT}`);
  console.log(`🔐 Secret token: ${SECRET_TOKEN}`);
  console.log(`📡 Waiting for multiplier batches...`);
  console.log(`🎮 Game phases: betting(${BETTING_PHASE_DURATION}ms) → flying → crashed → wait(${WAIT_PHASE_DURATION}ms)`);
  console.log(`⚡ Update interval: ${MULTIPLIER_UPDATE_INTERVAL}ms`);
  console.log(`🎯 Initial current round: ${currentRound}`);
  
  // Test multiplier calculation
  testMultiplierCalculation();
});

module.exports = { io, server };