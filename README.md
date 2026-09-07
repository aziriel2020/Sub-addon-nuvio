# BoomSubs Gemini

Addon de sous-titres compatible Stremio/Nuvio.

**Chaîne :** addon officiel OpenSubtitles v3 de Stremio → BoomSubs → Gemini → WebVTT traduit.

- Aucune clé API OpenSubtitles personnelle.
- Source amont : `https://opensubtitles-v3.strem.io`.
- Gemini conserve les timestamps et traduit le dialogue.
- Français par défaut, plusieurs langues disponibles.

## Vercel

Ajoute la variable d'environnement :

```
GEMINI_API_KEY=ta_cle_gemini
```

Puis installe dans Nuvio :

```
https://TON-DOMAINE.vercel.app/fr/manifest.json
```

Routes utiles : `/configure`, `/health`, `/{lang}/manifest.json`.
