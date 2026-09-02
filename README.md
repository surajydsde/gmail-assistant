# Executive Email Intelligence Dashboard

A production-ready full-stack executive assistant dashboard that integrates with the Gmail API, analyzes emails every 3 hours, scores urgency, prioritizes action items, and presents an interactive executive dashboard.

## Features
- **Gmail OAuth2 Integration**: Secure Google authentication with automatic token refreshing.
- **Automated Ingestion**: Scheduled background cron job running every 3 hours (`0 */3 * * *`) that performs delta synchronization (`after:last_sync`).
- **Intelligence & Categorization**: Analyzes urgency, extracts summaries, determines if immediate action/response is required, and assigns priority scores (0-100).
- **Interactive UI**: Search, category filters (Urgent, Requires Reply, Follow-up, Meetings, Finance, etc.), mark as reviewed, and deep links to Gmail threads.

## Quick Start

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment**:
   ```bash
   cp .env.example .env
   ```
   Add your Google OAuth Client ID and Secret obtained from Google Cloud Console. Make sure `http://localhost:3000/auth/callback` is added as an authorized redirect URI.

3. **Database Migration**:
   ```bash
   npm run db:push
   ```

4. **Start Application**:
   ```bash
   npm start
   ```

5. Open [http://localhost:3000](http://localhost:3000) and click **Connect Gmail**.
