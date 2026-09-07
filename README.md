# BoomSubs Gemini

Addon de sous-titres compatible Stremio/Nuvio.

**Chaîne :** addon officiel OpenSubtitles v3 de Stremio → BoomSubs → Gemini → WebVTT traduit.

- Aucune clé API OpenSubtitles personnelle.
- Source amont : `https://opensubtitles-v3.strem.io`.
- Gemini conserve les timestamps et traduit le dialogue.
- La clé Gemini n'a plus besoin d'être configurée dans Vercel.
- La configuration est transportée dans l'URL privée du manifest généré par la page `/configure`.

## Installation Nuvio

Ouvre :

```
https://sub-addon-nuvio-config-aziriel2020s-projects.vercel.app/configure
```

1. Colle ta clé Gemini.
2. Choisis Français.
3. Clique **Créer le manifest**.
4. Copie le lien généré.
5. Dans Nuvio, supprime l'ancienne version de BoomSubs puis ajoute ce nouveau manifest.

La clé n'est jamais commitée dans ce dépôt GitHub. Le lien généré contient la configuration encodée : garde-le privé.

## Routes

- `/configure`
- `/health`
- `/c/<config>/<lang>/manifest.json`

> Le code n'utilise aucune clé API OpenSubtitles personnelle. Il interroge l'addon officiel OpenSubtitles v3 de Stremio comme source amont.
