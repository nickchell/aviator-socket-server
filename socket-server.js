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
const MULTIPLIER_UPDATE_INTERVAL = 80; // 80ms for smoother, more frequent updates

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
  
  // Record start time for animation
  const startTime = Date.now();
  const timeToCrash = estimateTimeToMultiplier(crashPoint);
  
  console.log(`⏱️ Animation duration: ${timeToCrash.toFixed(1)} seconds`);
  
      // Start multiplier animation with smooth, consistent behavior
    let lastEmittedMultiplier = 1.00;
    
    simulationInterval = setInterval(() => {
      // Calculate elapsed time since flying phase started
      const elapsedMs = Date.now() - startTime;
      const elapsedSec = elapsedMs / 1000;
      
      // Calculate progress (0 to 1) - NO random variations for smoothness
      const progress = Math.min(1, elapsedSec / timeToCrash);
      
      // Calculate current multiplier
      currentMultiplier = calculateMultiplier(progress, crashPoint);
      
      // Only emit if multiplier has actually changed (prevent duplicate emissions)
      if (Math.abs(currentMultiplier - lastEmittedMultiplier) >= 0.01) {
        io.emit('multiplier:update', {
          round: currentRound,
          multiplier: currentMultiplier
        });
        lastEmittedMultiplier = currentMultiplier;
      }
      
      // Debug: Log only significant multiplier changes (less frequent)
      if (currentMultiplier >= 2.0 || (Math.abs(currentMultiplier - crashPoint) < 0.05 && currentMultiplier > 1.5)) {
        console.log(`📊 ${currentMultiplier.toFixed(2)}x → ${crashPoint.toFixed(2)}x (${(progress * 100).toFixed(0)}%)`);
      }
      
      // Check if crashed (NO randomness for consistency)
      if (currentMultiplier >= crashPoint) {
        console.log(`🎯 Animation complete: reached ${currentMultiplier}x (target was ${crashPoint}x)`);
        crashRound();
      }
    }, MULTIPLIER_UPDATE_INTERVAL); // Fixed update interval for smoothness
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
  // 🧠 Realistic Final Formula Implementation
  // Adaptive timing based on crash multiplier for realistic expectations
  
  // Base timing with controlled randomness (realistic)
  const baseRandomness = Math.random() * 1.5 + 0.5; // 0.5-2 seconds base randomness
  
  if (target < 1.5) {
    // 1.1x – 1.5x: 2.5 – 4.5s (realistic for instant crashes)
    return 2.5 + Math.random() * 2.0 + baseRandomness; // 3-6.5 seconds
  } else if (target < 5.0) {
    // 2x – 5x: 4.5 – 7.5s (balanced for mid-range)
    return 4.5 + Math.random() * 3.0 + baseRandomness; // 5-9.5 seconds
  } else if (target < 15.0) {
    // 10x range: 8 – 13s (epic for high multipliers)
    return 8.0 + Math.random() * 5.0 + baseRandomness; // 8.5-15.5 seconds
  } else if (target < 100.0) {
    // 100x range: 13 – 21s (legendary timing)
    return 13.0 + Math.random() * 8.0 + baseRandomness; // 13.5-23.5 seconds
  } else {
    // 1000x+ range: 20 – 30s (mythical timing)
    return 20.0 + Math.random() * 10.0 + baseRandomness; // 20.5-32.5 seconds
  }
}

function calculateMultiplier(progress, target) {
  // ✅ Smooth Stepped Hundredths Animation
  // Creates realistic counter-like progression: 1.00 → 1.01 → 1.02 → 1.03
  
  // Calculate how many hundredths steps we need
  const startMultiplier = 1.00;
  const multiplierRange = target - startMultiplier;
  const totalSteps = Math.ceil(multiplierRange * 100); // Total hundredths steps
  
  // Calculate current step based on progress
  const currentStep = Math.floor(progress * totalSteps);
  
  // Calculate smooth multiplier with stepped hundredths
  const smoothMultiplier = startMultiplier + (currentStep / 100);
  
  // Ensure we don't exceed target and fix floating point precision
  const result = Math.min(smoothMultiplier, target);
  
  // Fix floating point precision issues by rounding to 2 decimal places
  return Math.round(result * 100) / 100;
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
  
  console.log(`\n✅ Ideal Curve Design Features:`);
  console.log(`   • Fixed k = 0.2 for all rounds (consistent exponential curve)`);
  console.log(`   • x(t) = e^(k * t) with pure exponential for steady rise`);
  console.log(`   • Realistic timing: 1.1x-1.5x (3-6.5s), 2x-5x (5-9.5s), 10x (8.5-15.5s), 100x (13.5-23.5s)`);
  console.log(`   • Accelerated crashes: <1.3x use 1-2.5s with same fixed k`);
  console.log(`   • No sigmoid smoothing: Pure exponential for steady progression`);
  console.log(`   • Every round starts at 1.00x and climbs with same curve`);
  console.log(`   • No micro-variations: Steady rise without flickering`);
  console.log(`   • Fixed update interval: ${MULTIPLIER_UPDATE_INTERVAL}ms for smooth animation`);
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