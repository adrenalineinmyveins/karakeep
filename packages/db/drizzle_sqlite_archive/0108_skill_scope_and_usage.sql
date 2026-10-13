ALTER TABLE `agentSkills` ADD `knowledge_scope` text;--> statement-breakpoint
ALTER TABLE `consultationUsages` ADD `skillId` text REFERENCES agentSkills(id);