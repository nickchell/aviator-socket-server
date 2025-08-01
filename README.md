# Socket.IO Server for Aviator Crash Game

This is the real-time Socket.IO server that handles the live simulation of the Aviator crash game.

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd socket-server
npm install
```

### 2. Configure Environment

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
SOCKET_PORT=3001
SOCKET_SERVER_SECRET=your-secret-token-here
```

### 3. Start the Server

```bash
# Development mode with auto-restart
npm run dev

# Production mode
npm start
```

## 📡 API Endpoints

### POST /queue
Receives multiplier batches from the backend.

**Headers:**
```
Authorization: Bearer your-secret-token-here
Content-Type: application/json
```

**Body:**
```json
{
  "multipliers": [1.53, 2.17, 1.89, 3.45, ...]
}
```

### GET /health
Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "gamePhase": "flying",
  "currentRound": 123,
  "queueSize": 45,
  "currentMultiplier": 2.34
}
```

## 🔌 Socket.IO Events

### Emitted Events

- `game:state` - Initial game state when client connects
- `round:start` - New round started with betting phase
- `multiplier:update` - Real-time multiplier updates (every 50ms)
- `round:crash` - Round crashed at specific multiplier

### Event Data Examples

**round:start**
```json
{
  "round": 123,
  "crashPoint": 2.45
}
```

**multiplier:update**
```json
{
  "round": 123,
  "multiplier": 1.67
}
```

**round:crash**
```json
{
  "round": 123,
  "crashPoint": 2.45
}
```

## ⚙️ Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SOCKET_PORT` | 3001 | Port for the Socket.IO server |
| `SOCKET_SERVER_SECRET` | - | Secret token for authentication |

## 🎮 Game Flow

1. **Wait Phase** - Server waits for multiplier batches
2. **Betting Phase** - 6 seconds for players to place bets
3. **Flying Phase** - Multiplier animates from 1.00 to crash point
4. **Crash Phase** - Round ends, shows crash result
5. **Wait Phase** - 3 seconds before next round

## 🐛 Troubleshooting

### Common Issues

1. **Port Already in Use**
   ```bash
   # Check what's using the port
   netstat -ano | findstr :3001
   
   # Kill the process or change port in .env
   ```

2. **Authentication Errors**
   - Ensure `SOCKET_SERVER_SECRET` matches backend configuration
   - Check Authorization header format

3. **No Multipliers Processing**
   - Verify backend is sending to correct URL
   - Check server logs for queue status

### Debug Commands

```bash
# Check server health
curl http://localhost:3001/health

# Monitor logs
tail -f logs/socket-server.log
```

## 📊 Monitoring

The server provides detailed logging with emojis for easy identification:

- 🔌 Client connections/disconnections
- 📥 Multiplier batches received
- 🎮 Round starts
- ✈️ Flying phase starts
- 💥 Round crashes
- ⏸️ Simulation pauses

## 🔒 Security

- Bearer token authentication for `/queue` endpoint
- Input validation for multiplier arrays
- CORS configured for development (allow all origins)

## 🚀 Production

For production deployment:

1. Set production environment variables
2. Configure CORS for specific origins
3. Use HTTPS for Socket.IO connections
4. Add rate limiting and monitoring
5. Consider load balancing for multiple instances 