require('dotenv').config();
const express = require('express');
const { Octokit } = require('@octokit/rest');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Configuration
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const JENKINS_URL = process.env.JENKINS_URL;
const JENKINS_USER = process.env.JENKINS_USER;
const JENKINS_API_TOKEN = process.env.JENKINS_API_TOKEN;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL;
const PORT = process.env.PORT || 3000;

// Initialize GitHub client
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Store pour les webhooks (en mémoire, sans DB)
const webhookSecrets = new Map();

/**
 * API Endpoint: Add Repository
 * POST /add-repo
 */
app.post('/add-repo', async (req, res) => {
    const { repo_owner, repo_name, branch, user_id } = req.body;

    // Validation
    if (!repo_owner || !repo_name || !branch || !user_id) {
        return res.status(400).json({
            error: 'Missing required fields: repo_owner, repo_name, branch, user_id'
        });
    }

    try {
        console.log(`📦 Processing repository: ${repo_owner}/${repo_name}`);

        // 1. Générer un secret unique pour le webhook
        const webhookSecret = crypto.randomBytes(32).toString('hex');
        const webhookKey = `${repo_owner}/${repo_name}`;

        // 2. Créer le webhook GitHub
        console.log('🔗 Creating GitHub webhook...');
        const webhook = await octokit.repos.createWebhook({
            owner: repo_owner,
            repo: repo_name,
            config: {
                url: `${WEBHOOK_BASE_URL}/webhook/github`,
                content_type: 'json',
                secret: webhookSecret,
                insecure_ssl: '0'
            },
            events: ['push'],
            active: true
        });

        console.log(`✅ Webhook created: ID ${webhook.data.id}`);

        // 3. Stocker le secret (en mémoire)
        webhookSecrets.set(webhookKey, webhookSecret);

        // 4. Créer le job Jenkins (si nécessaire)
        const jenkinsJobName = `odoo-deploy-${user_id}`;
        await ensureJenkinsJobExists(jenkinsJobName);

        // 5. Déclencher la première build Jenkins
        console.log('🚀 Triggering initial Jenkins build...');
        const jenkinsBuildUrl = `${JENKINS_URL}/job/${jenkinsJobName}/buildWithParameters`;

        const jenkinsResponse = await axios.post(jenkinsBuildUrl, null, {
            auth: {
                username: JENKINS_USER,
                password: JENKINS_API_TOKEN
            },
            params: {
                REPO_OWNER: repo_owner,
                REPO_NAME: repo_name,
                BRANCH: branch,
                USER_ID: user_id
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        console.log(`✅ Jenkins build triggered: ${jenkinsResponse.status}`);

        // 6. Réponse de succès
        res.json({
            success: true,
            message: 'Repository added successfully',
            data: {
                webhook_id: webhook.data.id,
                webhook_url: webhook.data.config.url,
                jenkins_job: jenkinsJobName,
                repository: `${repo_owner}/${repo_name}`,
                branch: branch
            }
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
        
        // Gestion d'erreurs détaillée
        if (error.response) {
            return res.status(error.response.status).json({
                error: error.message,
                details: error.response.data
            });
        }

        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

/**
 * Webhook Endpoint: GitHub Push Events
 * POST /webhook/github
 */
app.post('/webhook/github', async (req, res) => {
    try {
        // 1. Vérifier la signature GitHub
        const signature = req.headers['x-hub-signature-256'];
        const event = req.headers['x-github-event'];

        console.log(`📨 Received GitHub webhook: ${event}`);

        // Ignorer les événements autres que push
        if (event !== 'push') {
            return res.status(200).send('Event ignored');
        }

        const payload = req.body;
        const repoFullName = payload.repository.full_name;
        const branch = payload.ref.replace('refs/heads/', '');
        const commitSha = payload.after;

        console.log(`📌 Push detected: ${repoFullName} on ${branch}`);

        // 2. Vérifier la signature
        const webhookSecret = webhookSecrets.get(repoFullName);
        
        if (!webhookSecret) {
            console.warn('⚠️  No webhook secret found for this repository');
            return res.status(404).send('Repository not registered');
        }

        const hmac = crypto.createHmac('sha256', webhookSecret);
        const digest = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');

        if (signature !== digest) {
            console.error('❌ Invalid signature');
            return res.status(401).send('Invalid signature');
        }

        console.log('✅ Signature verified');

        // 3. Extraire les infos
        const [repo_owner, repo_name] = repoFullName.split('/');
        
        // Pour simplifier, on utilise user_id = repo_owner
        const user_id = repo_owner;
        const jenkinsJobName = `odoo-deploy-${user_id}`;

        // 4. Déclencher Jenkins
        console.log(`🚀 Triggering Jenkins build for ${jenkinsJobName}...`);

        await axios.post(
            `${JENKINS_URL}/job/${jenkinsJobName}/buildWithParameters`,
            null,
            {
                auth: {
                    username: JENKINS_USER,
                    password: JENKINS_API_TOKEN
                },
                params: {
                    REPO_OWNER: repo_owner,
                    REPO_NAME: repo_name,
                    BRANCH: branch,
                    USER_ID: user_id,
                    COMMIT_SHA: commitSha
                }
            }
        );

        console.log('✅ Jenkins build triggered successfully');

        res.status(200).send('Webhook processed');

    } catch (error) {
        console.error('❌ Webhook error:', error.message);
        res.status(500).send('Internal error');
    }
});

/**
 * Health Check Endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        registered_repos: Array.from(webhookSecrets.keys())
    });
});

/**
 * Helper: Ensure Jenkins Job Exists
 * (Optionnel - pour auto-créer le job)
 */
async function ensureJenkinsJobExists(jobName) {
    try {
        // Vérifier si le job existe
        await axios.get(`${JENKINS_URL}/job/${jobName}/api/json`, {
            auth: {
                username: JENKINS_USER,
                password: JENKINS_API_TOKEN
            }
        });
        console.log(`ℹ️  Jenkins job '${jobName}' already exists`);
    } catch (error) {
        if (error.response && error.response.status === 404) {
            console.log(`⚙️  Jenkins job '${jobName}' not found - you need to create it manually`);
            // Note: La création automatique nécessite Jenkins Job DSL ou API complexe
            // Pour simplifier, on demande de créer le job manuellement
        } else {
            throw error;
        }
    }
}

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📝 Webhook URL: ${WEBHOOK_BASE_URL}/webhook/github`);
});