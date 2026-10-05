-- Cache authorization query plans on PostgreSQL 15–17 as well as 18.
-- SQL-language functions on older servers repeatedly plan these nested joins.
-- PL/pgSQL caches only the plan: each call still evaluates current rows, actor
-- settings and statement time under the caller's forced RLS. Predicates, STABLE
-- volatility, invoker privileges, search_path, grants and deadlines are unchanged.
BEGIN;
CREATE OR REPLACE FUNCTION margin_work.active(work uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 RETURN EXISTS(SELECT 1 FROM margin_assignments.student_work w
 JOIN margin_assignments.assignments a ON a.id=w.assignment_id AND a.organization_id=w.organization_id AND a.installation_id=w.installation_id AND a.course_id=w.course_id AND a.selected_at IS NOT NULL AND a.disabled_at IS NULL
 JOIN margin_assignments.resource_links r ON r.installation_id=w.installation_id AND r.resource_digest=w.resource_digest AND r.organization_id=w.organization_id AND r.course_id=w.course_id AND r.assignment_id=w.assignment_id
 JOIN margin_identity.memberships m ON m.organization_id=w.organization_id AND m.user_id=w.user_id AND m.role='student' AND m.revoked_at IS NULL
 JOIN margin_identity.users u ON u.id=w.user_id AND u.disabled_at IS NULL JOIN margin_identity.organizations o ON o.id=w.organization_id AND o.disabled_at IS NULL
 JOIN margin_lms.installations i ON i.id=w.installation_id AND i.organization_id=w.organization_id AND i.version=w.registration_version AND i.enabled
 JOIN margin_lms.user_links l ON l.installation_id=w.installation_id AND l.organization_id=w.organization_id AND l.user_id=w.user_id AND l.subject_digest=w.subject_digest AND l.disabled_at IS NULL
 JOIN margin_lms.courses c ON c.installation_id=w.installation_id AND c.organization_id=w.organization_id AND c.course_id=w.course_id AND c.external_digest=w.course_digest AND c.disabled_at IS NULL
 JOIN margin_lms.enrollments e ON e.installation_id=w.installation_id AND e.organization_id=w.organization_id AND e.course_id=w.course_id AND e.user_id=w.user_id AND e.role='student' AND e.disabled_at IS NULL
 WHERE w.id=work AND w.registration_version IS NOT NULL);
END
$$;

CREATE OR REPLACE FUNCTION margin_work.request_active() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
 RETURN EXISTS(SELECT 1 FROM margin_lms.session_bindings b
 JOIN margin_identity.sessions s ON s.id=b.session_id AND s.user_id=b.user_id AND s.organization_id=b.organization_id AND s.authentication_method='lti' AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp() AND s.idle_expires_at>statement_timestamp()
 JOIN margin_identity.memberships m ON m.organization_id=b.organization_id AND m.user_id=b.user_id AND m.role='student' AND m.revoked_at IS NULL
 JOIN margin_identity.users u ON u.id=b.user_id AND u.disabled_at IS NULL JOIN margin_identity.organizations o ON o.id=b.organization_id AND o.disabled_at IS NULL
 JOIN margin_lms.installations i ON i.id=b.installation_id AND i.organization_id=b.organization_id AND i.version=b.registration_version AND i.enabled
 JOIN margin_lms.courses c ON c.installation_id=b.installation_id AND c.organization_id=b.organization_id AND c.course_id=b.course_id AND c.external_digest=b.course_digest AND c.disabled_at IS NULL
 JOIN margin_lms.user_links l ON l.installation_id=b.installation_id AND l.organization_id=b.organization_id AND l.user_id=b.user_id AND l.subject_digest=b.subject_digest AND l.disabled_at IS NULL
 JOIN margin_lms.enrollments e ON e.installation_id=b.installation_id AND e.organization_id=b.organization_id AND e.course_id=b.course_id AND e.user_id=b.user_id AND e.role='student' AND e.disabled_at IS NULL
 WHERE b.session_id=margin_work.ctx('session_id') AND b.organization_id=margin_work.ctx('organization_id') AND b.user_id=margin_work.ctx('user_id') AND b.role='student');
END
$$;
COMMIT;
