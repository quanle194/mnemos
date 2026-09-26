"""Canonical enumerations shared by DB constraints, API schemas and services."""

from __future__ import annotations

from enum import StrEnum


class MemoryType(StrEnum):
    FACT = "fact"
    PREFERENCE = "preference"
    PROCEDURE = "procedure"
    RULE = "rule"
    CONSTRAINT = "constraint"
    DECISION = "decision"
    LESSON = "lesson"
    PATTERN = "pattern"
    WARNING = "warning"
    FAILURE = "failure"
    SUCCESS = "success"
    RELATIONSHIP = "relationship"
    CONTEXT = "context"


# Types that behave like policy/instructions; they need stronger evidence or review.
PRIVILEGED_TYPES = frozenset({MemoryType.RULE, MemoryType.CONSTRAINT, MemoryType.DECISION})


class MemoryStatus(StrEnum):
    CANDIDATE = "candidate"
    VALIDATED = "validated"
    ACTIVE = "active"
    DISPUTED = "disputed"
    SUPERSEDED = "superseded"
    ARCHIVED = "archived"
    REJECTED = "rejected"


RETRIEVABLE_STATUSES = (MemoryStatus.ACTIVE, MemoryStatus.VALIDATED)


class ScopeType(StrEnum):
    ORGANIZATION = "organization"
    WORKSPACE = "workspace"
    PROJECT = "project"
    AGENT = "agent"
    SESSION = "session"


class RelationType(StrEnum):
    SUPPORTS = "supports"
    CONTRADICTS = "contradicts"
    SUPERSEDES = "supersedes"
    DERIVED_FROM = "derived_from"
    RELATED_TO = "related_to"
    GENERALIZES = "generalizes"
    SPECIALIZES = "specializes"


class EvidenceSourceType(StrEnum):
    EVENT = "event"
    EPISODE = "episode"
    EXPERIENCE = "experience"
    USER_STATEMENT = "user_statement"
    DOCUMENT = "document"
    TOOL_RESULT = "tool_result"
    MEMORY = "memory"
    FEEDBACK = "feedback"


class FeedbackValue(StrEnum):
    HELPFUL = "helpful"
    IRRELEVANT = "irrelevant"
    INCORRECT = "incorrect"
    OUTDATED = "outdated"
    HARMFUL = "harmful"


class EventType(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"
    ERROR = "error"
    FEEDBACK = "feedback"
    TASK = "task"
    SYSTEM = "system"


class Outcome(StrEnum):
    SUCCESS = "success"
    FAILURE = "failure"
    PARTIAL = "partial"
    UNKNOWN = "unknown"


class ExperienceSource(StrEnum):
    AGENT = "agent"
    USER = "user"
    TOOL = "tool"
    EXTERNAL = "external"


class ConflictStatus(StrEnum):
    OPEN = "open"
    RESOLVED = "resolved"


class ConflictResolution(StrEnum):
    KEEP_EXISTING = "keep_existing"
    ACCEPT_CANDIDATE = "accept_candidate"
    KEEP_BOTH = "keep_both"
    ARCHIVE_BOTH = "archive_both"


class DreamMode(StrEnum):
    REFLECTION = "reflection"
    DEDUPLICATION = "deduplication"
    PATTERN = "pattern"
    CONTRADICTION = "contradiction"
    GENERALIZATION = "generalization"
    COMPRESSION = "compression"


class DreamStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"  # transient, will retry
    DEAD = "dead"


class Role(StrEnum):
    ADMIN = "admin"
    MAINTAINER = "maintainer"
    AGENT = "agent"
    VIEWER = "viewer"


class ReviewState(StrEnum):
    NONE = "none"
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class ValidationDecision(StrEnum):
    PROMOTE = "promote"
    MERGE = "merge"
    REJECT = "reject"
    DISPUTE = "dispute"
    REQUIRE_REVIEW = "require_review"
