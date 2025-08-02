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
const MULTIPLIER_UPDATE_INTERVAL = 100; // 100ms for smoother updates

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
    
    // Add random time variations to make it unpredictable
    const timeVariation = (Math.random() - 0.5) * 0.3; // ±0.15 seconds
    const adjustedElapsedSec = elapsedSec + timeVariation;
    
    // Calculate progress (0 to 1) with random adjustments
    let progress = Math.min(1, adjustedElapsedSec / timeToCrash);
    
    // Add random progress stalls and surges
    if (Math.random() < 0.1) {
      // 10% chance of a progress stall
      progress *= 0.6 + Math.random() * 0.4;
    }
    
    if (Math.random() < 0.05) {
      // 5% chance of a progress surge
      progress *= 1.1 + Math.random() * 0.3;
    }
    
    // Calculate current multiplier with unpredictability
    currentMultiplier = calculateMultiplier(progress, crashPoint);
    
    // Highly variable update timing
    const baseInterval = MULTIPLIER_UPDATE_INTERVAL;
    const randomVariation = (Math.random() - 0.5) * 60; // ±30ms random variation
    const sineVariation = Math.sin(progress * Math.PI * (2 + Math.random() * 3)) * 40; // Variable sine wave
    const dynamicInterval = baseInterval + randomVariation + sineVariation;
    
    // Randomly skip some updates to create unpredictability
    if (Math.random() < 0.08) {
      return; // Skip this update (8% chance)
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
    
    // Check if crashed - with some randomness
    if (currentMultiplier >= crashPoint || (Math.random() < 0.02 && progress > 0.95)) {
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
  // Highly unpredictable timing based on multiplier size
  const baseTime = Math.random() * 3 + 2; // 2-5 seconds base
  
  if (target < 1.5) {
    // Very low multipliers: Unpredictable quick timing
    return baseTime * (0.8 + Math.random() * 0.6); // 1.6-4 seconds
  } else if (target < 2.5) {
    // Low multipliers: Variable moderate timing
    return baseTime * (1.2 + Math.random() * 0.8); // 2.4-6 seconds
  } else if (target < 5.0) {
    // Medium multipliers: Unpredictable natural timing
    return baseTime * (1.5 + Math.random() * 1.2); // 3-8 seconds
  } else if (target < 15.0) {
    // High multipliers: Variable exciting timing
    return baseTime * (2.0 + Math.random() * 1.5); // 4-10 seconds
  } else {
    // Very high multipliers: Unpredictable epic timing
    return baseTime * (2.5 + Math.random() * 2.0); // 5-15 seconds
  }
}

function calculateMultiplier(progress, target) {
  // Unpredictable crash game animation with true randomness
  
  const startValue = 1.00;
  const range = target - startValue;
  
  // Generate unpredictable factors based on current time and progress
  const timeSeed = Date.now() % 10000;
  const progressSeed = Math.floor(progress * 1000);
  const randomFactor1 = Math.sin(timeSeed + progressSeed) * 0.02;
  const randomFactor2 = Math.cos(timeSeed * 0.7 + progressSeed * 1.3) * 0.015;
  const randomFactor3 = Math.sin(timeSeed * 1.4 + progressSeed * 0.8) * 0.01;
  
  // Create unpredictable easing patterns
  let baseProgress = progress;
  
  // Add random stalls and accelerations
  if (Math.random() < 0.15) {
    // 15% chance of a random stall
    baseProgress *= 0.7 + Math.random() * 0.3;
  }
  
  if (Math.random() < 0.08) {
    // 8% chance of a random acceleration
    baseProgress *= 1.2 + Math.random() * 0.4;
  }
  
  // Use different easing functions randomly
  const easingFunctions = [
    () => 1 - Math.pow(1 - baseProgress, 1.2), // Fast start
    () => 1 - Math.pow(1 - baseProgress, 1.8), // Slow start
    () => 1 - Math.pow(1 - baseProgress, 0.8), // Very fast start
    () => Math.sin(baseProgress * Math.PI * 0.5), // Sine curve
    () => baseProgress * baseProgress, // Quadratic
    () => Math.pow(baseProgress, 3), // Cubic
  ];
  
  const selectedEasing = easingFunctions[Math.floor(Math.random() * easingFunctions.length)];
  let easeOut = selectedEasing();
  
  // Add unpredictable variations
  const variation1 = Math.sin(progress * Math.PI * (3 + Math.random() * 4)) * (0.005 + Math.random() * 0.01);
  const variation2 = Math.cos(progress * Math.PI * (2 + Math.random() * 3)) * (0.003 + Math.random() * 0.008);
  const variation3 = Math.sin(progress * Math.PI * (5 + Math.random() * 6)) * (0.002 + Math.random() * 0.006);
  
  // Add micro-stalls and surges randomly
  let microVariation = 0;
  if (Math.random() < 0.12) {
    microVariation = Math.sin(progress * Math.PI * 11) * 0.008;
  }
  if (Math.random() < 0.06) {
    microVariation += Math.cos(progress * Math.PI * 13) * 0.006;
  }
  
  // Calculate final multiplier with all random factors
  let multiplier = startValue + (range * (easeOut + variation1 + variation2 + variation3 + microVariation + randomFactor1 + randomFactor2 + randomFactor3));
  
  // Add random spikes (rare but dramatic)
  if (Math.random() < 0.03) {
    multiplier += (Math.random() * 0.05) * range;
  }
  
  // Ensure we don't exceed the target
  multiplier = Math.min(multiplier, target);
  
  // Round to 2 decimal places for display
  return parseFloat(multiplier.toFixed(2));
}

// Test function to verify multiplier calculation
function testMultiplierCalculation() {
  console.log(`🎲 Testing Unpredictable Crash Game Animation:`);
  
  // Test different multiplier types with multiple runs to show randomness
  const testCases = [
    { target: 1.3, description: "Very low multiplier (1.3x)" },
    { target: 1.8, description: "Low multiplier (1.8x)" },
    { target: 3.5, description: "Medium multiplier (3.5x)" },
    { target: 8.0, description: "High multiplier (8.0x)" },
    { target: 25.0, description: "Very high multiplier (25.0x)" }
  ];
  
  console.log(`\n🎯 Final Values (3 runs each to show unpredictability):`);
  testCases.forEach(test => {
    console.log(`   ${test.description}:`);
    for (let run = 1; run <= 3; run++) {
      const result = calculateMultiplier(1.0, test.target);
      console.log(`     Run ${run}: ${result.toFixed(2)}x`);
    }
  });
  
  // Test unpredictable progression
  console.log(`\n📈 Unpredictable Progression Examples:`);
  
  console.log(`   Low multiplier (1.5x) - 3 different runs:`);
  for (let run = 1; run <= 3; run++) {
    console.log(`     Run ${run}:`);
    for (let progress = 0.2; progress <= 1.0; progress += 0.2) {
      const result = calculateMultiplier(progress, 1.5);
      console.log(`       ${(progress * 100).toFixed(0)}%: ${result.toFixed(2)}x`);
    }
  }
  
  console.log(`\n🎲 Unpredictable Features:`);
  console.log(`   • True randomness with time-based seeds`);
  console.log(`   • Random easing function selection`);
  console.log(`   • Unpredictable stalls and accelerations`);
  console.log(`   • Random micro-variations and spikes`);
  console.log(`   • Variable timing with random variations`);
  console.log(`   • Random update skips for unpredictability`);
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