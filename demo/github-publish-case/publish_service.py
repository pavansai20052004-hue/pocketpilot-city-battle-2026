def display_name(user: dict[str, str] | None) -> str:
    if user is None:
        return "Guest"
    return user["name"]
