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
	 * 返回固定的初始问候语，作为两个分支共同的开发起点。
	 */
	@GetMapping("/api/greeting")
	public Map<String, String> greeting() {
		return Map.of("message", "欢迎学习 Git 分支合并！");
	}

}
