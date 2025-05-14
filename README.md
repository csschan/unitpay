# unitpay

## Introduction

UnitPay is a decentralized payment system that turns stablecoins into real-world spending power. It supports:

- On-chain escrow and fund locking  
- Real-time status updates via Socket.io  
- Multiple payment methods (e.g. PayPal)  
- User dashboards for payers and LPs  

## Features

- Create payment intents with auto- or manual-matched liquidity providers (LP)  
- Secure escrow & locking via smart contracts  
- “Confirm Receipt” flow to release funds after satisfaction  
- WebSocket notifications for instant UI updates  
- PayPal integration for fiat payments  

## Technology Stack

- **Frontend:** HTML, CSS (Bootstrap v5), JavaScript  
- **Backend:** Node.js, Express.js, Sequelize ORM  
- **Blockchain:** @solana/web3.js  
- **Real-time:** Socket.io  
- **Database:** MySQL (PlanetScale)


## Prerequisites

- Node.js ≥14.x  
- npm ≥6.x  


## Installation

1. Clone the repo:  
   ```bash
   git clone https://github.com/your-username/unitpay.git
   cd unitpay
   ```
2. Install dependencies:  
   ```bash
   npm install
   ```
3. Copy & edit environment variables:  
   ```bash
   cp .env.example .env
   ```

## Usage

### Development

```bash
npm run dev
```  
Runs the server with nodemon at `http://localhost:4000`.

### Production

```bash
npm start
```  
Starts the server in production mode.

### Testing

```bash
npm test
```

### PM2 (Process Manager)

```bash
pm2 start ecosystem.config.js --only link
pm2 logs link
```

## Deployment

- **Frontend:** Deploy the `public/` folder to Vercel, Netlify, etc.  
- **Backend:** Deploy the Node.js app to Heroku, DigitalOcean, AWS, etc., with your `.env` vars.

