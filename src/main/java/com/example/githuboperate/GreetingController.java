package com.example.githuboperate;

import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 提供基础问候接口，供后续分支开发与合并练习使用。
 */
@RestController
public class GreetingController {

	/**
	 * 返回问候语与负责团队，便于调用方识别服务归属。
	 */
	@GetMapping("/api/greeting")
	public Map<String, String> greeting() {
		return Map.of("message", "欢迎学习 Git 分支合并！", "team", "后端团队");
	}

}
