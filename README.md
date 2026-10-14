Welcome to Axecleft's Shared Data module for the Dungeons and Dragons 3.5 SRD game system on FoundtyVTT.
The goal of this module is to allow the user to easily share custom content data between game worlds stored in the local FoundryVTT data folders. This allows the user to create custom content in one world and have access to it in others by storing the content in the module's compendiums.
This module will create empty compendiums that duplicate all of the system compendiums, allowing you to store data without editing the core system compendiums and risk loosing that data during a system update.

## Backup & Restore (v1.11.0+ for Foundry v11, v1.14.0+ for v13/v14)

Updating a module in Foundry replaces its whole folder, which used to wipe everything stored in these compendiums. Shared Data now keeps its own backup **outside** the module folder, so you can update it normally from the Setup screen.

**How it works**
- **Automatic backup:** whenever you add, edit or delete something in a Shared Data compendium, it is marked as changed and saved, either a few seconds after you stop editing it or on a timer, whichever you choose in the settings. When a world loads, only compendiums that changed since their last backup are saved.
- **Automatic restore:** when a world loads after an update, any Shared Data compendium that is empty is refilled from the backup. Compendiums that already have entries are never touched.
- Backups are stored in your Foundry user Data folder at `Data/axecleft-backups/SD-1/` (one JSON file per compendium, plus a copy of the module's `assets` folder such as scene thumbnails). Every world uses the same backup, just as they share the same compendiums.
- Only the GM's client does this work. Players are not affected.

**Settings** (Game Settings → Configure Settings → Axecleft's Shared Data)
- *Backup & Restore*: opens a window where you can back up now, restore missing entries, and compare the count in each compendium with the count in its backup.
- *Automatic backup* / *Automatic restore*: on by default.
- *Backup timing*: **After each change** (default) saves a compendium once you have stopped editing it for the set *Delay after a change* (10 seconds by default). **On a timer** saves all changed compendiums together every *Timer interval* minutes, so there are fewer saves during play. A changed compendium stays marked until it is saved, even if Foundry closes first.
- *Show backup activity*: shows a small "Shared Data: backing up…" label at the top of the screen while a backup or restore is running (per user).
- *Backup folder*: change where backups are kept. It must not be inside `modules/SD-1`.

**Before updating:** open a world with Shared Data active once, or click *Back up now*, so the backup is current. After the update, launch a world as GM and the content comes back.

**Restoring never deletes.** It only adds back entries (matched by ID) that are missing, so running it twice does no harm.

## Changelog
- **1.11.0**: Foundry v11.315 / D35E 2.4.3 build of 1.14.0: automatic backup and restore with adjustable timing, activity indicator, Backup & Restore window.
- **1.14.0**: Added automatic backup and restore of all compendiums and module assets, a Backup & Restore window, an English language file, and a manifest URL so Foundry can check for updates.
