import type { PrismaClient } from "@prisma/client";
import { createDeckRepository, type DeckRepository } from "./deck.js";
import { createVersionRepository, type VersionRepository } from "./version.js";
import { createNoteRepository, type NoteRepository } from "./note.js";
import {
  createAnnotationRepository,
  type AnnotationRepository,
} from "./annotation.js";
import { createInviteRepository, type InviteRepository } from "./invite.js";
import { createUserRepository, type UserRepository } from "./user.js";

export interface Repositories {
  deck: DeckRepository;
  version: VersionRepository;
  note: NoteRepository;
  annotation: AnnotationRepository;
  invite: InviteRepository;
  user: UserRepository;
}

export function createRepositories(prisma: PrismaClient): Repositories {
  return {
    deck: createDeckRepository(prisma),
    version: createVersionRepository(prisma),
    note: createNoteRepository(prisma),
    annotation: createAnnotationRepository(prisma),
    invite: createInviteRepository(prisma),
    user: createUserRepository(prisma),
  };
}

export type {
  DeckRepository,
  VersionRepository,
  NoteRepository,
  AnnotationRepository,
  InviteRepository,
  UserRepository,
};
