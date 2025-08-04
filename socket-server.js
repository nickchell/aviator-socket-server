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
const MULTIPLIER_UPDATE_INTERVAL = 120; // 120ms for smoother, slower updates

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

// Root endpoint for uptime monitoring (must be first)
app.get('/', (req, res) => {
  const response = { 
    status: 'ok', 
    service: 'aviator-socket-server',
    timestamp: new Date().toISOString()
  };
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json(response);
});

// Simple text endpoint for basic uptime monitoring
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
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
  
  // Start multiplier animation with unpredictable behavior
  simulationInterval = setInterval(() => {
    // Calculate elapsed time since flying phase started
    const elapsedMs = Date.now() - startTime;
    const elapsedSec = elapsedMs / 1000;
    
    // Add random time variations for unpredictability
    const timeVariation = (Math.random() - 0.5) * 0.5; // ±0.25 seconds
    const adjustedElapsedSec = elapsedSec + timeVariation;
    
    // Calculate progress (0 to 1) with random adjustments
    let progress = Math.min(1, adjustedElapsedSec / timeToCrash);
    
    // Add random progress stalls and surges
    if (Math.random() < 0.12) {
      // 12% chance of a progress stall
      progress *= 0.5 + Math.random() * 0.5;
    }
    
    if (Math.random() < 0.06) {
      // 6% chance of a progress surge
      progress *= 1.2 + Math.random() * 0.4;
    }
    
    // Calculate current multiplier
    currentMultiplier = calculateMultiplier(progress, crashPoint);
    
    // Randomly skip some updates to create unpredictability
    if (Math.random() < 0.1) {
      return; // Skip this update (10% chance)
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
    
    // Check if crashed with some randomness
    if (currentMultiplier >= crashPoint || (Math.random() < 0.01 && progress > 0.95)) {
      console.log(`🎯 Animation complete: reached ${currentMultiplier}x (target was ${crashPoint}x)`);
      crashRound();
    }
  }, MULTIPLIER_UPDATE_INTERVAL + Math.random() * 50); // Variable update interval
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

// Advanced exponential utility functions
function estimateTimeToMultiplier(target) {
  // 🧠 Final Formula Implementation
  // Adaptive timing based on crash multiplier for consistent realism
  
  // Base timing with controlled randomness
  const baseRandomness = Math.random() * 2 + 1; // 1-3 seconds base randomness
  
  if (target < 1.5) {
    // 1.1x – 1.5x: 1.5 – 2 s target
    return 1.5 + Math.random() * 0.5 + baseRandomness; // 2.5-5 seconds
  } else if (target < 5.0) {
    // 2x – 5x: 3 – 4 s target
    return 3.0 + Math.random() * 1.0 + baseRandomness; // 4-6 seconds
  } else if (target < 15.0) {
    // 10x range: 6 – 8 s target
    return 6.0 + Math.random() * 2.0 + baseRandomness; // 7-11 seconds
  } else if (target < 100.0) {
    // 100x range: 10 – 15 s target
    return 10.0 + Math.random() * 5.0 + baseRandomness; // 11-18 seconds
  } else {
    // 1000x+ range: 15 – 20 s target
    return 15.0 + Math.random() * 5.0 + baseRandomness; // 16-23 seconds
  }
}

function calculateMultiplier(progress, target) {
  // 🧠 Final Formula Implementation
  // Multiplier(t) = e^(k * t) where k = ln(C) / t_target
  
  // Calculate adaptive k based on target multiplier and animation duration
  const timeToCrash = estimateTimeToMultiplier(target);
  const k = Math.log(target) / timeToCrash;
  
  // 🧮 2. Use smoother easing for very large crash multipliers
  // Interpolate k over time to mimic acceleration: k(t) = k_min + (k_max - k_min) * (1 - e^(-a * t))
  
  const k_min = 0.1;  // Minimum k for smooth start
  const k_max = 0.5;  // Maximum k for acceleration
  const a = 2.0;      // Smoothing constant
  
  // Calculate adaptive k with smoothing
  const adaptiveK = k_min + (k_max - k_min) * (1 - Math.exp(-a * progress));
  
  // Apply exponential function with adaptive k
  let multiplier = Math.exp(adaptiveK * progress * timeToCrash);
  
  // Add natural easing for smoother movement
  const easingProgress = 1 - Math.pow(1 - progress, 1.2); // Gentle ease-out
  multiplier = Math.exp(adaptiveK * easingProgress * timeToCrash);
  
  // Add micro-variations for natural decimal movement
  const microVariation = Math.sin(progress * Math.PI * 5) * 0.008; // Subtle oscillation
  const tensionVariation = Math.cos(progress * Math.PI * 3) * 0.005; // Gentle tension
  
  multiplier += microVariation + tensionVariation;
  
  // Add rare random spikes for unpredictability (reduced frequency)
  if (Math.random() < 0.02) { // 2% chance instead of 5%
    multiplier += (Math.random() * 0.02) * (target - 1.0); // Smaller spikes
  }
  
  // Ensure we don't exceed the target
  multiplier = Math.min(multiplier, target);
  
  // Use precise rounding for natural decimal progression
  return parseFloat(multiplier.toFixed(2));
}

// Test function to verify advanced exponential multiplier calculation
function testMultiplierCalculation() {
  console.log(`🧠 Testing Advanced Exponential Crash Game Animation:`);
  
  // Test different multiplier types with mathematical precision
  const testCases = [
    { target: 1.3, description: "Short-range (1.3x) - Fast exponential rise" },
    { target: 1.8, description: "Low mid-range (1.8x) - Steady exponential" },
    { target: 3.5, description: "Mid-range (3.5x) - Balanced exponential" },
    { target: 8.0, description: "High range (8.0x) - Controlled exponential" },
    { target: 25.0, description: "Very high (25.0x) - Epic exponential" },
    { target: 100.0, description: "Ultra high (100.0x) - Legendary exponential" }
  ];
  
  console.log(`\n🎯 Mathematical Precision (Final Values):`);
  testCases.forEach(test => {
    const result = calculateMultiplier(1.0, test.target);
    const expected = test.target;
    const accuracy = Math.abs(result - expected);
    const timeToCrash = estimateTimeToMultiplier(test.target);
    const k = Math.log(test.target) / timeToCrash;
    console.log(`   ${test.description}: ${result.toFixed(2)}x (target: ${expected.toFixed(2)}x, accuracy: ${accuracy.toFixed(4)}, k: ${k.toFixed(4)}, time: ${timeToCrash.toFixed(1)}s)`);
  });
  
  // Test exponential progression with mathematical analysis
  console.log(`\n📈 Advanced Exponential Progression Analysis:`);
  
  console.log(`   Short-range (1.5x) - Adaptive k calculation:`);
  for (let progress = 0.2; progress <= 1.0; progress += 0.2) {
    const result = calculateMultiplier(progress, 1.5);
    const timeToCrash = estimateTimeToMultiplier(1.5);
    const k = Math.log(1.5) / timeToCrash;
    const pureExp = Math.exp(k * progress * timeToCrash);
    console.log(`     ${(progress * 100).toFixed(0)}%: ${result.toFixed(2)}x (pure: ${pureExp.toFixed(2)}x, k: ${k.toFixed(4)})`);
  }
  
  console.log(`   Mid-range (4.0x) - Adaptive k calculation:`);
  for (let progress = 0.2; progress <= 1.0; progress += 0.2) {
    const result = calculateMultiplier(progress, 4.0);
    const timeToCrash = estimateTimeToMultiplier(4.0);
    const k = Math.log(4.0) / timeToCrash;
    const pureExp = Math.exp(k * progress * timeToCrash);
    console.log(`     ${(progress * 100).toFixed(0)}%: ${result.toFixed(2)}x (pure: ${pureExp.toFixed(2)}x, k: ${k.toFixed(4)})`);
  }
  
  console.log(`\n🧮 Advanced Exponential Features:`);
  console.log(`   • M(t) = e^(k * t) where k = ln(C) / t_target (adaptive k)`);
  console.log(`   • k(t) = k_min + (k_max - k_min) * (1 - e^(-a * t)) (smoother easing)`);
  console.log(`   • Adaptive timing: 1.1x-1.5x (2.5-5s), 2x-5x (4-6s), 10x (7-11s), 100x (11-18s)`);
  console.log(`   • Natural acceleration with k_min=0.1, k_max=0.5, a=2.0`);
  console.log(`   • Gentle ease-out: 1 - (1-t)^1.2 for smoother movement`);
  console.log(`   • Micro-variations: sin(π*5*t)*0.008 + cos(π*3*t)*0.005`);
  console.log(`   • Reduced random spikes: 2% chance instead of 5%`);
  console.log(`   • Mathematical precision with exact target values`);
  
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

// Catch-all route for 404s (must be last)
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Not Found', 
    message: 'Endpoint not found',
    availableEndpoints: ['/', '/ping', '/health', '/debug', '/current-state', '/queue']
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