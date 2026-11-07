"""Create or reset an admin account.

Usage:  python -m app.create_admin admin@company.com "StrongPassword1" "Full Name"
"""

import sys

from sqlalchemy import func, select

from .database import Base, SessionLocal, engine, ensure_schema
from .models import Role, User
from .security import hash_password


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    email, password = sys.argv[1].lower(), sys.argv[2]
    name = sys.argv[3] if len(sys.argv) > 3 else "Administrator"
    if len(password) < 8:
        sys.exit("Password must be at least 8 characters")

    ensure_schema()
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        user = db.scalars(select(User).where(func.lower(User.email) == email)).first()
        if user:
            user.password_hash = hash_password(password)
            user.role = Role.admin
            user.is_active = True
            print(f"Updated existing user {email} as admin")
        else:
            db.add(
                User(
                    email=email,
                    full_name=name,
                    password_hash=hash_password(password),
                    role=Role.admin,
                    tracking_enabled=False,
                )
            )
            print(f"Created admin {email}")
        db.commit()


if __name__ == "__main__":
    main()
