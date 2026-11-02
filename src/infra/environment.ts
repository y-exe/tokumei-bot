import { config } from 'dotenv';

if (process.env.LOCAL_DEVELOPMENT !== '1') config({ quiet: true });
