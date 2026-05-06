# Polysong Local Source

Local ingestion handles user-selected files and folders. The production scanner should only read paths the user explicitly selects, then copy or link files into the configured app data library based on settings.

Metadata extraction belongs in a dedicated library module with `lofty`; this source currently prepares a track candidate from the selected path so the frontend and Tauri command surface are functional.

