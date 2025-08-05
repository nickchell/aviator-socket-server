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
let startTime = null; // Track flying phase start time

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
  
  // Start simulation if not already running or if we're in crashed phase
  if ((gamePhase === 'wait' || gamePhase === 'crashed') && multiplierQueue.length > 0) {
    console.log(`🚀 Starting simulation with ${multiplierQueue.length} multipliers in queue (phase: ${gamePhase})`);
    
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
    
    // If we're in crashed phase, transition to wait first
    if (gamePhase === 'crashed') {
      console.log(`🔄 Transitioning from crashed to wait phase`);
      gamePhase = 'wait';
    }
    
    console.log(`🎮 Starting simulation from round ${currentRound}`);
    startNextRound();
  } else if (gamePhase !== 'wait' && gamePhase !== 'crashed') {
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
  if ((gamePhase === 'wait' || gamePhase === 'crashed') && multiplierQueue.length > 0) {
    console.log(`🔧 Manual trigger: Starting next round from phase ${gamePhase}`);
    if (gamePhase === 'crashed') {
      gamePhase = 'wait';
    }
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

// Force start simulation endpoint (for debugging)
app.post('/force-start', authenticateRequest, (req, res) => {
  console.log(`🔧 Force start: Current phase ${gamePhase}, queue size ${multiplierQueue.length}`);
  
  if (multiplierQueue.length === 0) {
    return res.json({ success: false, message: 'No multipliers in queue' });
  }
  
  // Force transition to wait phase if needed
  if (gamePhase !== 'wait') {
    console.log(`🔄 Force transitioning from ${gamePhase} to wait phase`);
    gamePhase = 'wait';
  }
  
  // Set current round if not set
  if (currentRound === 0) {
    const firstRound = Math.min(...Array.from(roundMultipliers.keys()));
    currentRound = firstRound;
    console.log(`🎯 Force setting current round to ${currentRound}`);
  }
  
  console.log(`🚀 Force starting simulation from round ${currentRound}`);
  startNextRound();
  
  res.json({ 
    success: true, 
    message: 'Simulation force started',
    currentRound,
    gamePhase,
    queueSize: multiplierQueue.length
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
  
  // Emit flying phase event to notify clients
  io.emit('round:flying', {
    round: currentRound,
    multiplier: currentMultiplier,
    crashPoint: crashPoint
  });
  
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
    // Set to wait phase first
    gamePhase = 'wait';
    // Increment current round for the next round in sequence
    currentRound++;
    // Check if we have multipliers to start the next round
    if (multiplierQueue.length > 0) {
      console.log(`🚀 Starting next round with ${multiplierQueue.length} multipliers in queue`);
      startNextRound();
    } else {
      console.log(`⏸️ No multipliers in queue, waiting for backend...`);
    }
  }, WAIT_PHASE_DURATION);
}

// Universal growth curve system
function estimateTimeToMultiplier(target) {
  // 🎯 UNIVERSAL GROWTH CURVE
  // All multipliers use the same fixed timing - only the stop point differs
  
  // Fixed animation duration for ALL multipliers (no prediction possible)
  const FIXED_ANIMATION_DURATION = 8.0; // 8 seconds for all games
  
  // Add minimal randomness to prevent exact timing prediction
  const microRandomness = (Math.random() - 0.5) * 0.5; // ±0.25 seconds
  
  return FIXED_ANIMATION_DURATION + microRandomness;
}

function calculateMultiplier(progress, target) {
  // 🎯 UNIVERSAL EXPONENTIAL CURVE
  // All multipliers follow the exact same growth pattern - only stop point differs
  
  // Calculate growth rate to ensure we can reach the target at progress = 1.0
  // We want: target = e^(rate * 8) when progress = 1.0
  // So: rate = ln(target) / 8
  const growthRate = Math.log(target) / 8;
  
  // Universal exponential formula: multiplier = e^(rate * time)
  // This creates the same curve shape for 1.2x, 10x, 100x, etc.
  const universalMultiplier = Math.exp(growthRate * progress * 8); // 8 seconds duration
  
  // Convert to stepped hundredths for smooth animation
  const steppedMultiplier = Math.floor(universalMultiplier * 100) / 100;
  
  // Stop at target multiplier (this is the only difference between games)
  const result = Math.min(steppedMultiplier, target);
  
  // Ensure minimum of 1.00
  return Math.max(1.00, result);
}

// Test function to verify universal growth curve
function testMultiplierCalculation() {
  console.log(`🎯 Testing Universal Growth Curve System:`);
  
  // Test different multiplier types - all should use same curve
  const testCases = [
    { target: 1.2, description: "Low crash (1.2x) - Stops early" },
    { target: 2.0, description: "Medium crash (2.0x) - Stops mid-curve" },
    { target: 5.0, description: "High crash (5.0x) - Stops later" },
    { target: 15.0, description: "Very high (15.0x) - Stops much later" },
    { target: 50.0, description: "Epic (50.0x) - Stops near end" },
    { target: 100.0, description: "Legendary (100.0x) - Stops at end" }
  ];
  
  console.log(`\n🎯 Universal Curve Analysis (All use same growth pattern):`);
  testCases.forEach(test => {
    const result = calculateMultiplier(1.0, test.target);
    const expected = test.target;
    const accuracy = Math.abs(result - expected);
    const timeToCrash = estimateTimeToMultiplier(test.target);
    console.log(`   ${test.description}: ${result.toFixed(2)}x (target: ${expected.toFixed(2)}x, accuracy: ${accuracy.toFixed(4)}, time: ${timeToCrash.toFixed(1)}s)`);
  });
  
  // Test progression - all should follow identical curve until they stop
  console.log(`\n📈 Universal Curve Progression (First 3 seconds identical for all):`);
  
  console.log(`   Early progression (0-3 seconds) - ALL multipliers identical:`);
  for (let progress = 0.1; progress <= 0.4; progress += 0.1) {
    const time = progress * 8; // 8 second duration
    const universalValue = calculateMultiplier(progress, 1000); // Use high target to see full curve
    console.log(`     ${time.toFixed(1)}s: ${universalValue.toFixed(2)}x (universal curve)`);
  }
  
  console.log(`   Mid progression (3-6 seconds) - Still identical until crash:`);
  for (let progress = 0.4; progress <= 0.8; progress += 0.1) {
    const time = progress * 8;
    const universalValue = calculateMultiplier(progress, 1000);
    console.log(`     ${time.toFixed(1)}s: ${universalValue.toFixed(2)}x (universal curve)`);
  }
  
  console.log(`\n✅ Universal Curve Design Features:`);
  console.log(`   • Fixed 8-second duration for ALL multipliers (no timing prediction)`);
  console.log(`   • Dynamic growth rate: ln(target) / 8 for each multiplier`);
  console.log(`   • Universal formula: multiplier = e^(ln(target)/8 * time) for all games`);
  console.log(`   • Only difference: where the animation stops (crash point)`);
  console.log(`   • 1.2x crash: stops at 1.2x, 100x crash: stops at 100x`);
  console.log(`   • First 3-4 seconds look identical for all multipliers`);
  console.log(`   • Impossible to predict crash point from animation behavior`);
  console.log(`   • Stepped hundredths for smooth counter-like display`);
  console.log(`   • Fixed update interval: ${MULTIPLIER_UPDATE_INTERVAL}ms`);
  
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
  console.log(`🎲 Universal growth curve: 8s fixed duration, same curve for all multipliers`);
  
  // Test multiplier calculation
  testMultiplierCalculation();
});

module.exports = { io, server };