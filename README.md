# Orion Lux Panel

Private operations dashboard for managing costs, inventory, and sales of the Orion Lux moissanite & 925 sterling silver jewelry brand.

**Stack:** plain static site (HTML + CSS + JS). No build step. Hosted on GitHub Pages.

---

## Deployment — step by step

### 1. Create the GitHub repo and push

```bash
# Inside this directory:
git init
git add .
git commit -m "feat: initial Orion Lux Panel"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/orion-lux-panel.git
git push -u origin main
```

Replace `YOUR_USERNAME` and `orion-lux-panel` with your actual GitHub username and the repo name you created on GitHub.com.

---

### 2. Enable GitHub Pages

1. Go to your repo on GitHub.
2. Click **Settings** → **Pages** (left sidebar).
3. Under *Source*, select **Deploy from a branch**.
4. Choose branch `main` and folder `/ (root)`.
5. Click **Save**.

GitHub will give you a URL like `https://YOUR_USERNAME.github.io/orion-lux-panel/`. It takes about 1–2 minutes the first time.

---

### 3. Create a fine-grained Personal Access Token (PAT)

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**.
2. Click **Generate new token**.
3. Set a descriptive name (e.g. "orion-lux-panel-write").
4. Under **Repository access**, choose **Only select repositories** and pick your `orion-lux-panel` repo.
5. Under **Permissions**, expand **Repository permissions** → set **Contents** to **Read and write**. That's the only permission needed.
6. Click **Generate token** and **copy it immediately** — GitHub won't show it again.

---

### 4. First-time login

1. Open your GitHub Pages URL.
2. The login card will appear with two fields: **Token de GitHub** and **Contraseña**.
3. Paste the token you just created into the Token field.
4. Type the dashboard password in the Contraseña field.
5. Click **Entrar**.

The app will encrypt the token with your password using AES-GCM (derived via PBKDF2) and store *only the ciphertext* in `localStorage`. **The token is never stored in plaintext and is never committed to the repo.**

On future visits, only the password field is shown — the app decrypts the stored token automatically.

---

### 5. Configure the repository connection

1. Click **⚙️** in the top bar.
2. Fill in:
   - **Owner**: your GitHub username or organization.
   - **Nombre del repositorio**: `orion-lux-panel` (or whatever you named it).
   - **Rama**: `main`.
   - **Ruta del archivo**: `data.json`.
3. Click **Guardar**.

The app will immediately fetch `data.json` from GitHub.

---

### 6. Day-to-day use

- Edit costs, inventory, and sales freely. Changes stay in memory.
- When ready to save, click **Guardar y publicar**. This commits `data.json` to GitHub, which triggers an automatic GitHub Pages redeploy (usually takes under 1 minute).
- The sync status indicator in the top bar shows whether there are unsaved changes or the last publish succeeded.

---

## Privacy note

> **If this repo is public**, `data.json` (your costs, inventory, and sales data) is publicly readable directly from GitHub — the login gate only protects the editing UI in the browser.
>
> If the numbers must stay private, use a **private repo** with a host that supports private repos and auto-deploys on push — [Vercel](https://vercel.com) is free for this use case and works identically (the same GitHub API save flow still works). Simply deploy the same files to Vercel instead of GitHub Pages.

The PAT itself is **only ever stored encrypted in the owner's own browser `localStorage`** — it is never in the source code and never committed to the repo.

---

## Security model

| What is protected | How |
|---|---|
| GitHub token at rest | AES-GCM encrypted under a PBKDF2-derived key. Only ciphertext lives in `localStorage`. |
| Dashboard editing UI | Gated behind the password. Wrong password = failed decryption = no access. |
| Token in transit | Only sent to `api.github.com` over HTTPS. |
| What is **not** protected | `data.json` content if repo is public (readable by anyone via raw GitHub URL). |

This scheme stops casual snooping on a shared device. It is not server-validated authentication — a determined person with full control of the browser session could still access the app. Use a private repo if the financial data must stay confidential.

---

## Logout

Click **Salir** in the top bar. The in-memory token is cleared and you return to the login screen. The encrypted vault stays in `localStorage` so next visit only needs the password.

To fully reset (e.g. to use a different token), click **Usar otro token / reset** on the login screen — this wipes the vault and shows the full first-run form again.

---

## File structure

```
orion-lux-panel/
├── index.html   — app shell + login card + modals
├── styles.css   — black/silver theme
├── app.js       — all logic: crypto, GitHub API, 4 tabs
├── data.json    — live data (committed on every "Guardar y publicar")
└── README.md    — this file
```
