package store

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// ListMyChannelsPage returns one page of the channels the caller is a member of,
// for a picker (the New Task dialog's "Assign to → Channels").
//
// It exists beside ListChannels, not instead of it. ListChannels is the sidebar's
// list: every membership, each with a last-message preview and an unread count,
// ordered by activity — expensive per row and meant to be read whole. A picker
// wants none of that; it wants a page of names it can search and keep scrolling.
// So this projects only what a picker shows (id, name, member count, lock, role)
// and orders by name, a key that does not move while the caller pages.
//
// `query` is a plain case-insensitive substring match on the (plaintext) name;
// strpos rather than LIKE so `%` and `_` in what someone types are literal.
// Offset paging, the same pair GET /channels/open takes. Member counts are
// aggregated for the page's own rows only.
func (s *Store) ListMyChannelsPage(
	ctx context.Context, orgID, callerID, query string, limit, offset int,
) ([]ChannelDTO, error) {
	limit = clampChannelPage(limit)
	offset = clampOffset(offset)
	out := []ChannelDTO{}
	// Primary pool, not the replica: the caller's own memberships, and a channel
	// they created a moment ago must be pickable straight away.
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			WITH page AS (
			    SELECT c.id, c.name, c.is_locked, c.created_by, cm.role
			    FROM channels c
			    JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2
			    WHERE c.org_id = $1
			      AND ($3 = '' OR strpos(lower(c.name), lower($3)) > 0)
			    ORDER BY lower(c.name), c.id
			    LIMIT $4 OFFSET $5
			)
			SELECT page.id, page.name, page.is_locked, page.created_by, page.role,
			       (SELECT count(*) FROM channel_members m WHERE m.channel_id = page.id) AS member_count
			FROM page
			ORDER BY lower(page.name), page.id`,
			orgID, callerID, query, limit, offset)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var d ChannelDTO
			var createdBy, role *string
			if err := rows.Scan(&d.ID, &d.Name, &d.IsLocked, &createdBy, &role, &d.MemberCount); err != nil {
				return err
			}
			if createdBy != nil {
				d.CreatedBy = *createdBy
			}
			if role != nil {
				d.MyRole = *role
			}
			d.IAmMember = true
			out = append(out, d)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
